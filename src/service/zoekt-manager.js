import { spawn, execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

export class ZoektManager {
  constructor(config) {
    this.indexDir = config.indexDir;
    this.wslIndexDir = null; // WSL-native index path (faster than /mnt/c/)
    this.wslMirrorDir = null; // WSL-native mirror copy (faster reads for indexing)
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
    this.useWsl = false; // Whether to run Zoekt via WSL2
    this._indexingActive = false;
    this._pendingProjects = new Set();
  }

  /**
   * Convert a Windows path to WSL path format.
   * C:\Users\foo\bar -> /mnt/c/Users/foo/bar
   */
  _toWslPath(winPath) {
    const normalized = winPath.replace(/\\/g, '/');
    // Match drive letter: C:/... -> /mnt/c/...
    const match = normalized.match(/^([A-Za-z]):\/(.*)/);
    if (match) {
      return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
    }
    return normalized;
  }

  _findBinaries() {
    const candidates = [];

    if (this.zoektBin) {
      candidates.push(this.zoektBin);
    }

    // Check GOPATH/bin
    const gopath = process.env.GOPATH || join(process.env.USERPROFILE || process.env.HOME || '', 'go');
    candidates.push(join(gopath, 'bin'));

    // Check PATH for native binaries
    try {
      const which = process.platform === 'win32' ? 'where' : 'which';
      const indexPath = execSync(`${which} zoekt-index`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n')[0].trim();
      if (indexPath) {
        this.zoektIndexPath = indexPath;
        this.zoektWebPath = indexPath.replace('zoekt-index', 'zoekt-webserver');
        if (process.platform === 'win32') {
          this.zoektWebPath = this.zoektWebPath.replace('zoekt-index.exe', 'zoekt-webserver.exe');
        }
        return true;
      }
    } catch {}

    // Check candidate directories for native binaries
    for (const dir of candidates) {
      const ext = process.platform === 'win32' ? '.exe' : '';
      const indexPath = join(dir, `zoekt-index${ext}`);
      const webPath = join(dir, `zoekt-webserver${ext}`);
      if (existsSync(indexPath) && existsSync(webPath)) {
        this.zoektIndexPath = indexPath;
        this.zoektWebPath = webPath;
        return true;
      }
    }

    // On Windows, try WSL2 as fallback (Zoekt doesn't build natively on Windows)
    if (process.platform === 'win32') {
      return this._findWslBinaries();
    }

    return false;
  }

  _findWslBinaries() {
    try {
      // Check if WSL is available and has Zoekt installed
      // Also get the home directory for WSL-native index storage
      const result = execSync(
        'wsl -d Ubuntu -- bash -c "export PATH=/usr/local/go/bin:$HOME/go/bin:$PATH && which zoekt-index 2>/dev/null && which zoekt-webserver 2>/dev/null && echo $HOME"',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
      ).trim();

      const lines = result.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length >= 3) {
        this.zoektIndexPath = lines[0];
        this.zoektWebPath = lines[1];
        const wslHome = lines[2];
        // Use WSL-native filesystem for index + mirror (much faster than /mnt/c/)
        this.wslIndexDir = `${wslHome}/.zoekt-index`;
        this.wslMirrorDir = `${wslHome}/.zoekt-mirror`;
        this.useWsl = true;
        return true;
      }
    } catch {}

    return false;
  }

  /**
   * Spawn a process, either directly or via WSL depending on platform.
   */
  _spawn(binaryPath, args) {
    if (this.useWsl) {
      // Run via WSL: translate all path arguments to WSL paths
      const wslArgs = args.map(arg => {
        // Detect Windows absolute paths and convert them
        if (/^[A-Za-z]:[\\/]/.test(arg)) {
          return this._toWslPath(arg);
        }
        return arg;
      });

      const bashCmd = `export PATH=/usr/local/go/bin:$HOME/go/bin:$PATH && ${binaryPath} ${wslArgs.map(a => `'${a}'`).join(' ')}`;
      return spawn('wsl', ['-d', 'Ubuntu', '--', 'bash', '-c', bashCmd], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    }

    return spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  }

  /**
   * Initialize binaries and directories. Must be called before syncMirror() or start().
   */
  init() {
    if (!this._findBinaries()) {
      console.warn('[ZoektManager] Zoekt binaries not found. Install with: go install github.com/sourcegraph/zoekt/cmd/...@latest');
      return false;
    }

    const mode = this.useWsl ? 'WSL2' : 'native';
    console.log(`[ZoektManager] Found binaries (${mode}): ${this.zoektIndexPath}`);

    if (this.useWsl && this.wslIndexDir) {
      try {
        execSync(`wsl -d Ubuntu -- bash -c "mkdir -p '${this.wslIndexDir}' '${this.wslMirrorDir}'"`, { stdio: 'ignore', timeout: 5000 });
        console.log(`[ZoektManager] Using WSL-native dirs: index=${this.wslIndexDir}, mirror=${this.wslMirrorDir}`);
      } catch (err) {
        console.warn(`[ZoektManager] Failed to create WSL dirs, falling back to Windows paths`);
        this.wslIndexDir = null;
        this.wslMirrorDir = null;
      }
    }

    if (!this.useWsl) {
      mkdirSync(this.indexDir, { recursive: true });
    }

    return true;
  }

  async start() {
    // Kill any stale Zoekt webservers from previous runs (only on initial startup)
    this._killStaleWebservers();
    await this._waitForPortFree(10000);

    return this._startWebserver();
  }

  _killStaleWebservers() {
    try {
      if (this.useWsl) {
        execSync(`wsl -d Ubuntu -- bash -c "pkill -9 -f zoekt-webserver 2>/dev/null; pkill -9 -f zoekt-web 2>/dev/null"`,
          { stdio: 'ignore', timeout: 5000 });
      } else {
        const result = execSync(`netstat -ano | findstr ":${this.webPort}.*LISTENING"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        const pids = [...new Set(result.split('\n').map(l => l.trim().split(/\s+/).pop()).filter(Boolean))];
        for (const pid of pids) {
          try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); } catch {}
        }
      }
    } catch {}
  }

  /**
   * Wait until the webserver port is actually free (not just killed).
   * WSL port forwarding can take several seconds to release.
   */
  async _waitForPortFree(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await fetch(`http://127.0.0.1:${this.webPort}/`, { signal: AbortSignal.timeout(1000) });
        // Port still in use — wait and retry
        await new Promise(r => setTimeout(r, 500));
      } catch {
        // Connection refused = port is free
        return true;
      }
    }
    console.warn(`[ZoektManager] Port ${this.webPort} still in use after ${timeoutMs}ms`);
    return false;
  }

  /**
   * Get the effective index directory path (WSL-native or Windows).
   * Used in _startWebserver and runIndex.
   */
  _getIndexDirArg() {
    if (this.useWsl && this.wslIndexDir) {
      return this.wslIndexDir; // Already a Linux path
    }
    return this.useWsl ? this._toWslPath(this.indexDir) : this.indexDir;
  }

  async _startWebserver() {
    // Prevent concurrent restart attempts
    if (this._restartPending) return Promise.resolve(false);

    return new Promise((resolve) => {
      const args = [
        '-index', this._getIndexDirArg(),
        '-rpc',
        '-listen', `:${this.webPort}`
      ];

      console.log(`[ZoektManager] Starting webserver on port ${this.webPort}...`);
      this.webProcess = this._spawn(this.zoektWebPath, args);

      // Track the specific process we spawned so health checks verify the right one
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
        // Only handle exit if this is still OUR current process
        if (this.webProcess !== thisProcess && this.webProcess !== null) return;

        console.log(`[ZoektManager] Webserver exited (code=${code}, signal=${signal})`);
        this.available = false;
        this.webProcess = null;

        if (!resolved) {
          resolved = true;
          resolve(false);
        }

        // Schedule restart if under max attempts and no restart already pending
        if (!this._restartPending && this.restartAttempts < this.maxRestartAttempts) {
          this._restartPending = true;
          this.restartAttempts++;
          const delay = Math.min(1000 * Math.pow(2, this.restartAttempts - 1), 30000);
          console.log(`[ZoektManager] Restarting in ${delay}ms (attempt ${this.restartAttempts}/${this.maxRestartAttempts})...`);
          setTimeout(async () => {
            this._restartPending = false;
            // Wait for port to be free (no pkill — our process already exited)
            await this._waitForPortFree(5000);
            this._startWebserver();
          }, delay);
        } else if (this.restartAttempts >= this.maxRestartAttempts) {
          console.error(`[ZoektManager] Max restart attempts (${this.maxRestartAttempts}) reached, giving up`);
        }
      });

      // Health check — verify OUR process is actually serving
      this._waitForHealthy(10000).then((healthy) => {
        if (resolved) return; // process already exited
        // Verify the process that passed health check is still our current process
        if (this.webProcess !== thisProcess) {
          if (!resolved) { resolved = true; resolve(false); }
          return;
        }
        resolved = true;
        if (healthy) {
          this.available = true;
          // Don't reset restartAttempts immediately — wait for stability
          // Reset after 10s of continuous uptime
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

  /**
   * Sync mirror from Windows filesystem to WSL-native filesystem.
   * Uses tar pipe for initial copy (much faster than rsync through 9P bridge),
   * and rsync for incremental updates.
   */
  async _syncMirrorToWsl(mirrorRoot) {
    if (!this.useWsl || !this.wslMirrorDir) return this.useWsl ? this._toWslPath(mirrorRoot) : mirrorRoot;

    const wslMirrorSrc = this._toWslPath(mirrorRoot);
    const startMs = performance.now();

    // Check if WSL mirror already has files (incremental sync)
    let existingCount = 0;
    try {
      const countOutput = execSync(
        `wsl -d Ubuntu -- bash -c "find '${this.wslMirrorDir}' -type f 2>/dev/null | wc -l"`,
        { encoding: 'utf-8', timeout: 10000 }
      ).trim();
      existingCount = parseInt(countOutput, 10) || 0;
    } catch {}

    if (existingCount > 1000) {
      // WSL mirror already has files — use it directly
      // Rsync through 9P bridge is too slow for 400K+ files (30+ min just for stat checks)
      // The mirror is kept in sync by the watcher + tar pipe for initial setup
      console.log(`[ZoektManager] WSL mirror has ${existingCount} files, using directly (skipping rsync)`);
      return this.wslMirrorDir;
    }

    // Initial bulk copy: tar pipe is 10x+ faster than individual file copies through 9P
    console.log('[ZoektManager] Initial mirror sync to WSL-native filesystem (tar pipe)...');
    return new Promise((resolve) => {
      const tarCmd = `cd '${wslMirrorSrc}' && tar cf - . | (mkdir -p '${this.wslMirrorDir}' && cd '${this.wslMirrorDir}' && tar xf -)`;
      const proc = spawn('wsl', ['-d', 'Ubuntu', '--', 'bash', '-c', tarCmd], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('exit', (code) => {
        const durationS = ((performance.now() - startMs) / 1000).toFixed(1);
        if (code === 0) {
          console.log(`[ZoektManager] Mirror sync complete (${durationS}s)`);
          resolve(this.wslMirrorDir);
        } else {
          console.warn(`[ZoektManager] Tar sync failed (code=${code}): ${stderr.slice(0, 200)}`);
          console.warn('[ZoektManager] Falling back to /mnt/c/ path');
          resolve(wslMirrorSrc);
        }
      });
      proc.on('error', () => resolve(wslMirrorSrc));
    });
  }

  /**
   * Sync mirror to WSL-native filesystem before starting Zoekt.
   * Must be called before start() to avoid concurrent WSL process issues.
   */
  async syncMirror(mirrorRoot) {
    this.mirrorRoot = mirrorRoot;
    this._effectiveMirrorPath = await this._syncMirrorToWsl(mirrorRoot);
    return this._effectiveMirrorPath;
  }

  /**
   * Discover project subdirectories in the mirror root.
   * Each subdirectory becomes its own Zoekt shard.
   */
  _listMirrorProjects(effectiveMirrorPath) {
    if (this.useWsl) {
      try {
        const output = execSync(
          `wsl -d Ubuntu -- bash -c "for d in '${effectiveMirrorPath}'/*/; do [ -d \\\"\\$d\\\" ] && basename \\\"\\$d\\\"; done 2>/dev/null"`,
          { encoding: 'utf-8', timeout: 10000 }
        ).trim();
        return output.split('\n').filter(Boolean);
      } catch { return []; }
    }

    try {
      return readdirSync(effectiveMirrorPath, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(d => d.name);
    } catch { return []; }
  }

  /**
   * Index a single project's directory into its own Zoekt shard.
   * Uses -incremental to skip unchanged files and -shard_prefix for per-project shards.
   */
  async _runIndexForProject(projectName, effectiveMirrorPath) {
    return new Promise((resolve, reject) => {
      const startMs = performance.now();
      const projectDir = `${effectiveMirrorPath}/${projectName}`;
      const args = [
        '-index', this._getIndexDirArg(),
        '-incremental',
        '-shard_prefix', projectName,
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

  /**
   * Index specific projects (scoped reindex).
   * Only reindexes the given project directories instead of the entire mirror.
   */
  async reindexProjects(projectNames) {
    if (this._indexingActive) {
      console.log('[ZoektManager] Index already running, skipping...');
      return;
    }

    const effectiveMirrorPath = this._effectiveMirrorPath;
    if (!effectiveMirrorPath) {
      console.warn('[ZoektManager] No effective mirror path, cannot reindex');
      return;
    }

    this._indexingActive = true;
    const startMs = performance.now();
    const names = [...projectNames];
    console.log(`[ZoektManager] Scoped reindex: ${names.join(', ')}...`);

    try {
      const results = await Promise.allSettled(
        names.map(p => this._runIndexForProject(p, effectiveMirrorPath))
      );

      const durationS = ((performance.now() - startMs) / 1000).toFixed(1);
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      this.lastIndexCompleteTime = new Date().toISOString();
      this.lastIndexDurationS = parseFloat(durationS);
      console.log(`[ZoektManager] Scoped reindex complete: ${succeeded} OK, ${failed} failed (${durationS}s)`);
    } finally {
      this._indexingActive = false;
    }
  }

  async runIndex(mirrorRoot) {
    this.mirrorRoot = mirrorRoot;

    if (this._indexingActive || this.indexProcess) {
      console.log('[ZoektManager] Index already running, skipping...');
      return;
    }

    // Use pre-synced path if available, otherwise sync now
    const effectiveMirrorPath = this._effectiveMirrorPath || await this._syncMirrorToWsl(mirrorRoot);

    // Discover project directories for per-project shard indexing
    const projects = this._listMirrorProjects(effectiveMirrorPath);

    if (projects.length > 0) {
      console.log(`[ZoektManager] Starting per-project index (${projects.length} projects)...`);
      await this.reindexProjects(projects);
      return;
    }

    // Fallback: single monolithic index (no project directories found)
    this._indexingActive = true;
    return new Promise((resolve, reject) => {
      const startMs = performance.now();
      const args = [
        '-index', this._getIndexDirArg(),
        '-parallelism', String(this.parallelism),
        '-file_limit', String(this.fileLimitBytes),
        effectiveMirrorPath
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
   * Write a single file to the WSL-native mirror (for incremental updates from watcher).
   * Individual file writes through WSL are fast — it's bulk operations that are slow.
   */
  updateWslMirrorFile(relativePath, content) {
    if (!this.useWsl || !this.wslMirrorDir) return;
    try {
      const normalized = relativePath.replace(/\\/g, '/');
      const wslPath = `${this.wslMirrorDir}/${normalized}`;
      const dir = wslPath.slice(0, wslPath.lastIndexOf('/'));
      execSync(`wsl -d Ubuntu -- bash -c "mkdir -p '${dir}'"`, { timeout: 5000, stdio: 'pipe' });
      spawnSync('wsl', ['-d', 'Ubuntu', '--', 'bash', '-c', `cat > '${wslPath}'`], {
        input: typeof content === 'string' ? content : content.toString('utf-8'),
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      console.warn(`[ZoektManager] WSL mirror update failed for ${relativePath}: ${err.message}`);
    }
  }

  deleteWslMirrorFile(relativePath) {
    if (!this.useWsl || !this.wslMirrorDir) return;
    try {
      const normalized = relativePath.replace(/\\/g, '/');
      const wslPath = `${this.wslMirrorDir}/${normalized}`;
      execSync(`wsl -d Ubuntu -- bash -c "rm -f '${wslPath}'"`, { timeout: 5000, stdio: 'pipe' });
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

    // Adaptive debounce: 2s for small changes, up to 30s for large batches
    const debounce = Math.min(30000, 2000 + this._pendingChangeCount * 200);

    this.reindexTimer = setTimeout(async () => {
      const count = this._pendingChangeCount;
      const projects = new Set(this._pendingProjects);
      this._pendingChangeCount = 0;
      this._pendingProjects.clear();
      this.reindexTimer = null;

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
    return {
      available: this.isAvailable(),
      port: this.webPort,
      indexing: this._indexingActive || this.indexProcess !== null,
      lastIndexTime: this.lastIndexCompleteTime,
      lastIndexDurationS: this.lastIndexDurationS,
      restartAttempts: this.restartAttempts,
      useWsl: this.useWsl
    };
  }

  /**
   * Bootstrap mirror directly to WSL via tar pipe, skipping the Windows filesystem.
   * Streams tar data from zoektMirror.bootstrapToStream() into WSL tar extraction.
   */
  async bootstrapDirect(database, zoektMirror, onProgress = null) {
    if (!this.useWsl || !this.wslMirrorDir) {
      throw new Error('bootstrapDirect requires WSL mode');
    }

    const startMs = performance.now();
    console.log('[ZoektManager] Direct-to-WSL bootstrap via tar stream...');

    return new Promise((resolve, reject) => {
      const tarCmd = `mkdir -p '${this.wslMirrorDir}' && cd '${this.wslMirrorDir}' && tar xf -`;
      const proc = spawn('wsl', ['-d', 'Ubuntu', '--', 'bash', '-c', tarCmd], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });

      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });

      proc.on('exit', (code) => {
        const durationS = ((performance.now() - startMs) / 1000).toFixed(1);
        if (code === 0) {
          this._effectiveMirrorPath = this.wslMirrorDir;
          console.log(`[ZoektManager] Direct bootstrap complete (${durationS}s)`);
          resolve();
        } else {
          const msg = `Direct bootstrap failed (code=${code}, ${durationS}s): ${stderr.slice(0, 200)}`;
          console.error(`[ZoektManager] ${msg}`);
          reject(new Error(msg));
        }
      });

      proc.on('error', reject);

      // Stream tar entries from the database directly into WSL
      zoektMirror.bootstrapToStream(database, proc.stdin, onProgress)
        .then(() => {
          proc.stdin.end();
        })
        .catch(err => {
          proc.stdin.end();
          reject(err);
        });
    });
  }

  async stop() {
    if (this.reindexTimer) {
      clearTimeout(this.reindexTimer);
      this.reindexTimer = null;
    }

    // Prevent auto-restart during shutdown
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
