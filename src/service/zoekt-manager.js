import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';

export class ZoektManager {
  constructor(config) {
    this.indexDir = config.indexDir;
    this.webPort = config.webPort || 6070;
    this.parallelism = config.parallelism || 4;
    this.fileLimitBytes = config.fileLimitBytes || 524288;
    this.reindexDebounceMs = config.reindexDebounceMs || 5000;
    this.zoektBin = config.zoektBin || null;

    this.webProcess = null;
    this.indexProcess = null;
    this.reindexTimer = null;
    this.reindexPromise = null;
    this.mirrorRoot = null;
    this.available = false;
    this.restartAttempts = 0;
    this.maxRestartAttempts = 5;
    this._restartPending = false;
    this.lastIndexCompleteTime = null;
    this.lastIndexDurationS = null;
    this.zoektIndexPath = null;
    this.zoektWebPath = null;
    this._indexingActive = false;
    this._pendingProjects = new Set();
  }

  _findBinaries() {
    const candidates = [];

    if (this.zoektBin) {
      candidates.push(this.zoektBin);
    }

    // Check GOPATH/bin
    const gopath = process.env.GOPATH || join(process.env.HOME || '', 'go');
    candidates.push(join(gopath, 'bin'));

    // Check PATH
    try {
      const indexPath = execSync('which zoekt-index', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (indexPath) {
        this.zoektIndexPath = indexPath;
        this.zoektWebPath = indexPath.replace('zoekt-index', 'zoekt-webserver');
        return true;
      }
    } catch {}

    // Check candidate directories
    for (const dir of candidates) {
      const indexPath = join(dir, 'zoekt-index');
      const webPath = join(dir, 'zoekt-webserver');
      if (existsSync(indexPath) && existsSync(webPath)) {
        this.zoektIndexPath = indexPath;
        this.zoektWebPath = webPath;
        return true;
      }
    }

    return false;
  }

  _spawn(binaryPath, args) {
    return spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  init() {
    if (!this._findBinaries()) {
      console.warn('[ZoektManager] Zoekt binaries not found. Install with: go install github.com/sourcegraph/zoekt/cmd/...@latest');
      return false;
    }

    console.log(`[ZoektManager] Found binaries: ${this.zoektIndexPath}`);
    mkdirSync(this.indexDir, { recursive: true });
    return true;
  }

  async start() {
    this._killStaleWebservers();
    await this._waitForPortFree(10000);
    return this._startWebserver();
  }

  _killStaleWebservers() {
    try {
      execSync('pkill -9 -f zoekt-webserver 2>/dev/null; pkill -9 -f zoekt-web 2>/dev/null',
        { stdio: 'ignore', timeout: 5000 });
    } catch {}
  }

  async _waitForPortFree(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await fetch(`http://127.0.0.1:${this.webPort}/`, { signal: AbortSignal.timeout(1000) });
        await new Promise(r => setTimeout(r, 500));
      } catch {
        return true;
      }
    }
    console.warn(`[ZoektManager] Port ${this.webPort} still in use after ${timeoutMs}ms`);
    return false;
  }

  async _startWebserver() {
    if (this._restartPending) return Promise.resolve(false);

    return new Promise((resolve) => {
      const args = [
        '-index', this.indexDir,
        '-rpc',
        '-listen', `:${this.webPort}`
      ];

      console.log(`[ZoektManager] Starting webserver on port ${this.webPort}...`);
      this.webProcess = this._spawn(this.zoektWebPath, args);

      const thisProcess = this.webProcess;
      let resolved = false;

      this.webProcess.stdout.on('data', (data) => {
        const line = data.toString().trim();
        if (line) console.log(`[zoekt-web] ${line}`);
      });

      this.webProcess.stderr.on('data', (data) => {
        const line = data.toString().trim();
        if (line) console.log(`[zoekt-web] ${line}`);
      });

      this.webProcess.on('exit', (code, signal) => {
        if (this.webProcess !== thisProcess && this.webProcess !== null) return;

        console.log(`[ZoektManager] Webserver exited (code=${code}, signal=${signal})`);
        this.available = false;
        this.webProcess = null;

        if (!resolved) {
          resolved = true;
          resolve(false);
        }

        if (!this._restartPending && this.restartAttempts < this.maxRestartAttempts) {
          this._restartPending = true;
          this.restartAttempts++;
          const delay = Math.min(1000 * Math.pow(2, this.restartAttempts - 1), 30000);
          console.log(`[ZoektManager] Restarting in ${delay}ms (attempt ${this.restartAttempts}/${this.maxRestartAttempts})...`);
          setTimeout(async () => {
            this._restartPending = false;
            await this._waitForPortFree(5000);
            this._startWebserver();
          }, delay);
        } else if (this.restartAttempts >= this.maxRestartAttempts) {
          console.error(`[ZoektManager] Max restart attempts (${this.maxRestartAttempts}) reached, giving up`);
        }
      });

      this._waitForHealthy(10000).then((healthy) => {
        if (resolved) return;
        if (this.webProcess !== thisProcess) {
          if (!resolved) { resolved = true; resolve(false); }
          return;
        }
        resolved = true;
        if (healthy) {
          this.available = true;
          setTimeout(() => {
            if (this.webProcess === thisProcess) {
              this.restartAttempts = 0;
            }
          }, 10000);
          console.log(`[ZoektManager] Webserver ready on port ${this.webPort}`);
        } else {
          console.warn('[ZoektManager] Webserver failed health check');
        }
        resolve(healthy);
      });
    });
  }

  async _waitForHealthy(timeoutMs) {
    const start = Date.now();
    const interval = 500;
    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await fetch(`http://127.0.0.1:${this.webPort}/`);
        if (resp.ok || resp.status === 200) return true;
      } catch {}
      await new Promise(r => setTimeout(r, interval));
    }
    return false;
  }

  _listMirrorProjects(mirrorPath) {
    try {
      return readdirSync(mirrorPath, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(d => d.name);
    } catch { return []; }
  }

  async _runIndexForProject(projectName, mirrorPath) {
    const projectDir = join(mirrorPath, projectName);
    // Skip projects with no mirror directory (e.g. config files, _assets)
    if (!existsSync(projectDir)) {
      return;
    }
    return new Promise((resolve, reject) => {
      const startMs = performance.now();
      const args = [
        '-index', this.indexDir,
        '-parallelism', String(Math.max(1, Math.floor(this.parallelism / 2))),
        '-file_limit', String(this.fileLimitBytes),
        projectDir
      ];

      const proc = this._spawn(this.zoektIndexPath, args);
      let stderr = '';
      proc.stdout.on('data', (data) => {
        const line = data.toString().trim();
        if (line) console.log(`[zoekt-index:${projectName}] ${line}`);
      });
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        const line = data.toString().trim();
        if (line) console.log(`[zoekt-index:${projectName}] ${line}`);
      });

      proc.on('exit', (code) => {
        const durationS = ((performance.now() - startMs) / 1000).toFixed(1);
        if (code === 0) {
          resolve({ project: projectName, durationS: parseFloat(durationS) });
        } else {
          const msg = `Index ${projectName} failed (code=${code}, ${durationS}s): ${stderr.slice(0, 200)}`;
          console.error(`[ZoektManager] ${msg}`);
          reject(new Error(msg));
        }
      });

      proc.on('error', reject);
    });
  }

  async reindexProjects(projectNames) {
    if (this._indexingActive) {
      console.log('[ZoektManager] Index already running, skipping...');
      return;
    }

    if (!this.mirrorRoot) {
      console.warn('[ZoektManager] No mirror root set, cannot reindex');
      return;
    }

    this._indexingActive = true;
    const startMs = performance.now();
    const names = [...projectNames];
    console.log(`[ZoektManager] Scoped reindex: ${names.join(', ')}...`);

    try {
      const results = await Promise.allSettled(
        names.map(p => this._runIndexForProject(p, this.mirrorRoot))
      );

      const durationS = ((performance.now() - startMs) / 1000).toFixed(1);
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failedProjects = names.filter((_, i) => results[i].status === 'rejected');

      this.lastIndexCompleteTime = new Date().toISOString();
      this.lastIndexDurationS = parseFloat(durationS);
      console.log(`[ZoektManager] Scoped reindex complete: ${succeeded} OK, ${failedProjects.length} failed (${durationS}s)`);

      // Clean up old monolithic shards
      if (succeeded > 0 && !this._oldShardsCleanedUp) {
        this._cleanupOldShards();
      }

      // Retry failed projects once after 30s
      if (failedProjects.length > 0 && !this._retryInProgress) {
        this._retryInProgress = true;
        setTimeout(async () => {
          this._retryInProgress = false;
          console.log(`[ZoektManager] Retrying failed projects: ${failedProjects.join(', ')}...`);
          try {
            await this.reindexProjects(failedProjects);
          } catch (err) {
            console.error(`[ZoektManager] Retry also failed: ${err.message}`);
          }
        }, 30000);
      }
    } finally {
      this._indexingActive = false;
    }
  }

  _cleanupOldShards() {
    if (!this.mirrorRoot) return;
    try {
      const validProjects = new Set(this._listMirrorProjects(this.mirrorRoot));
      const files = readdirSync(this.indexDir);
      let removed = 0;

      for (const f of files) {
        // Remove tmp files
        if (f.endsWith('.tmp')) {
          try { unlinkSync(join(this.indexDir, f)); removed++; } catch {}
          continue;
        }
        // Remove old monolithic shards
        if (f.startsWith('.zoekt-mirror_') && f.endsWith('.zoekt')) {
          try { unlinkSync(join(this.indexDir, f)); removed++; } catch {}
          continue;
        }
        // Remove orphaned project shards (project no longer in mirror)
        if (f.endsWith('.zoekt')) {
          const m = f.match(/^(.+?)_v\d+\.\d+\.zoekt$/);
          if (m) {
            const shardProject = decodeURIComponent(m[1]);
            if (!validProjects.has(shardProject)) {
              try { unlinkSync(join(this.indexDir, f)); removed++; } catch {}
            }
          }
        }
      }

      if (removed > 0) {
        console.log(`[ZoektManager] Cleaned up ${removed} stale/orphaned shard files`);
      }
      this._oldShardsCleanedUp = true;
    } catch (err) {
      console.warn(`[ZoektManager] Failed to clean up old shards: ${err.message}`);
    }
  }

  async runIndex(mirrorRoot) {
    this.mirrorRoot = mirrorRoot;

    if (this._indexingActive || this.indexProcess) {
      console.log('[ZoektManager] Index already running, skipping...');
      return;
    }

    // Remove orphaned shards before indexing
    if (!this._oldShardsCleanedUp) {
      this._cleanupOldShards();
    }

    const projects = this._listMirrorProjects(mirrorRoot);

    if (projects.length > 0) {
      console.log(`[ZoektManager] Starting per-project index (${projects.length} projects)...`);
      await this.reindexProjects(projects);
      return;
    }

    // Fallback: single monolithic index
    this._indexingActive = true;
    return new Promise((resolve, reject) => {
      const startMs = performance.now();
      const args = [
        '-index', this.indexDir,
        '-parallelism', String(this.parallelism),
        '-file_limit', String(this.fileLimitBytes),
        mirrorRoot
      ];

      console.log(`[ZoektManager] Starting full index of ${mirrorRoot}...`);
      this.indexProcess = this._spawn(this.zoektIndexPath, args);

      let stderr = '';
      this.indexProcess.stdout.on('data', (data) => {
        const line = data.toString().trim();
        if (line) console.log(`[zoekt-index] ${line}`);
      });
      this.indexProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        const line = data.toString().trim();
        if (line) console.log(`[zoekt-index] ${line}`);
      });

      this.indexProcess.on('exit', (code) => {
        this.indexProcess = null;
        this._indexingActive = false;
        const durationS = ((performance.now() - startMs) / 1000).toFixed(1);

        if (code === 0) {
          this.lastIndexCompleteTime = new Date().toISOString();
          this.lastIndexDurationS = parseFloat(durationS);
          console.log(`[ZoektManager] Index complete (${durationS}s)`);
          resolve();
        } else {
          const msg = `Index failed (code=${code}, ${durationS}s): ${stderr.slice(0, 200)}`;
          console.error(`[ZoektManager] ${msg}`);
          reject(new Error(msg));
        }
      });

      this.indexProcess.on('error', (err) => {
        this.indexProcess = null;
        this._indexingActive = false;
        reject(err);
      });
    });
  }

  /**
   * Write a file to the local mirror directory (for incremental updates).
   */
  updateMirrorFile(relativePath, content) {
    if (!this.mirrorRoot) return;
    try {
      const fullPath = join(this.mirrorRoot, relativePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
    } catch (err) {
      console.warn(`[ZoektManager] Mirror update failed for ${relativePath}: ${err.message}`);
    }
  }

  /**
   * Delete a file from the local mirror directory.
   */
  deleteMirrorFile(relativePath) {
    if (!this.mirrorRoot) return;
    try {
      unlinkSync(join(this.mirrorRoot, relativePath));
    } catch {}
  }

  triggerReindex(changeCount = 1, affectedProjects = null) {
    if (!this.mirrorRoot) return;
    this._pendingChangeCount = (this._pendingChangeCount || 0) + changeCount;

    if (affectedProjects) {
      for (const p of affectedProjects) this._pendingProjects.add(p);
    }

    if (this.reindexTimer) {
      clearTimeout(this.reindexTimer);
    }

    const debounce = Math.min(30000, 2000 + this._pendingChangeCount * 200);

    this.reindexTimer = setTimeout(async () => {
      this.reindexTimer = null;

      if (this._indexingActive) {
        console.log('[ZoektManager] Index active, re-queuing pending changes...');
        this.reindexTimer = setTimeout(() => this.triggerReindex(0), 5000);
        return;
      }

      const count = this._pendingChangeCount;
      const projects = new Set(this._pendingProjects);
      this._pendingChangeCount = 0;
      this._pendingProjects.clear();

      try {
        if (projects.size > 0) {
          console.log(`[ZoektManager] Scoped reindex after ${count} change(s) in: ${[...projects].join(', ')}...`);
          await this.reindexProjects(projects);
        } else {
          console.log(`[ZoektManager] Full reindex after ${count} change(s)...`);
          await this.runIndex(this.mirrorRoot);
        }
      } catch (err) {
        console.error(`[ZoektManager] Reindex failed: ${err.message}`);
      }
    }, debounce);
  }

  isAvailable() {
    return this.available && this.webProcess !== null;
  }

  getPort() {
    return this.webPort;
  }

  getStatus() {
    let shardCount = null;
    try {
      if (existsSync(this.indexDir)) {
        shardCount = readdirSync(this.indexDir).filter(f => f.endsWith('.zoekt')).length;
      }
    } catch {}
    return {
      running: this.webProcess !== null,
      available: this.isAvailable(),
      port: this.webPort,
      shardCount,
      indexing: this._indexingActive || this.indexProcess !== null,
      lastIndexTime: this.lastIndexCompleteTime,
      lastIndexDurationS: this.lastIndexDurationS,
      restartAttempts: this.restartAttempts,
      maxRestartAttempts: this.maxRestartAttempts
    };
  }

  async stop() {
    if (this.reindexTimer) {
      clearTimeout(this.reindexTimer);
      this.reindexTimer = null;
    }

    this.maxRestartAttempts = 0;

    if (this.indexProcess) {
      this.indexProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (this.indexProcess) {
        try { this.indexProcess.kill('SIGKILL'); } catch {}
      }
    }

    if (this.webProcess) {
      this.webProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 2000));
      if (this.webProcess) {
        try { this.webProcess.kill('SIGKILL'); } catch {}
      }
    }

    this.available = false;
    console.log('[ZoektManager] Stopped');
  }
}
