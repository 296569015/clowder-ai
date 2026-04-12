// ServiceManager — spawns and monitors Redis, API, and Web processes.
// Used by the Electron main process to manage backend services.

const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');

const POLL_INTERVAL_MS = 500;
const MAX_WAIT_MS = 120_000;

// Log file for diagnosing service startup issues
const LOG_FILE = path.join(process.env.TEMP || 'C:\\Temp', 'clowder-desktop.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

// Resolve node executable: prefer system node over Electron's own node
function resolveNode() {
  // Common Windows locations
  const candidates = [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    path.join(process.env.APPDATA || '', '..', 'Local', 'Programs', 'node', 'node.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'node'; // fallback to PATH
}

class ServiceManager {
  constructor(projectRoot, { frontendPort, apiPort, onStatus }) {
    this.root = projectRoot;
    this.frontendPort = frontendPort;
    this.apiPort = apiPort;
    this.onStatus = onStatus || (() => {});
    this.procs = {};
  }

  async startAll() {
    log(`ServiceManager.startAll() — projectRoot: ${this.root}`);
    this.onStatus('Starting Redis...');
    await this._startRedis();

    const nodeExe = resolveNode();
    log(`Using node: ${nodeExe}`);
    this.onStatus('Starting API server...');
    this._startProcess('api', nodeExe, [
      path.join(this.root, 'packages', 'api', 'dist', 'index.js'),
    ]);
    log('API process spawned, waiting for port ' + this.apiPort);
    await this._waitForPort(this.apiPort, 'API');

    this.onStatus('Starting Web frontend...');
    this._startNextJs();
    log('Web process spawned, waiting for port ' + this.frontendPort);
    await this._waitForPort(this.frontendPort, 'Web');

    this.onStatus('Ready!');
  }

  async _startRedis() {
    const portableRedis = path.join(
      this.root, '.cat-cafe', 'redis', 'windows', 'redis-server.exe',
    );
    const redisConf = path.join(
      this.root, '.cat-cafe', 'redis', 'windows', 'redis.conf',
    );

    // Already running — reuse it
    if (await this._isPortOpen(6399)) {
      this.onStatus('Redis already running on 6399');
      return;
    }

    // Check if any Redis binary is available
    const hasPortable = fs.existsSync(portableRedis);
    const hasSystem = await this._commandExists('redis-server');

    if (!hasPortable && !hasSystem) {
      this.onStatus('Redis not found — using memory store');
      this.memoryMode = true;
      return;
    }

    let redisCmd = 'redis-server';
    let redisArgs = ['--port', '6399', '--save', '', '--appendonly', 'no'];

    if (hasPortable) {
      redisCmd = portableRedis;
      if (fs.existsSync(redisConf)) {
        redisArgs = [redisConf, '--port', '6399'];
      }
    }

    this._startProcess('redis', redisCmd, redisArgs);
    await this._waitForPort(6399, 'Redis');
  }

  _commandExists(cmd) {
    return new Promise((resolve) => {
      const which = process.platform === 'win32' ? 'where' : 'which';
      const p = spawn(which, [cmd], { stdio: 'ignore', windowsHide: true });
      p.on('close', (code) => resolve(code === 0));
      p.on('error', () => resolve(false));
    });
  }

  _startNextJs() {
    const webDir = path.join(this.root, 'packages', 'web');
    // Find next's actual JS entry to avoid .cmd/.sh wrapper issues with spawn
    const nextJs = path.join(
      this.root,
      'node_modules', '.pnpm',
      'next@14.2.35_@babel+core@7.29.0_@opentelemetry+api@1.9.1_react-dom@18.3.1_react@18.3.1__react@18.3.1',
      'node_modules', 'next', 'dist', 'bin', 'next',
    );
    const nodeExe = resolveNode();

    let cmd, args;
    if (fs.existsSync(nextJs)) {
      // Use node + next JS directly — avoids .cmd spawn issues on Windows
      cmd = nodeExe;
      args = [nextJs, 'start', '--port', String(this.frontendPort)];
    } else {
      // Fallback: use cmd.exe to run next.cmd
      cmd = 'cmd.exe';
      args = ['/c', path.join(webDir, 'node_modules', '.bin', 'next.cmd'), 'start', '--port', String(this.frontendPort)];
    }

    log(`Starting Next.js: ${cmd} ${args.join(' ')}`);
    this._startProcess('web', cmd, args, { cwd: webDir });
  }

  _startProcess(name, cmd, args, opts = {}) {
    const env = {
      ...process.env,
      API_SERVER_PORT: String(this.apiPort),
      FRONTEND_PORT: String(this.frontendPort),
      NEXT_PUBLIC_API_URL: `http://localhost:${this.apiPort}`,
    };

    if (this.memoryMode) {
      env.MEMORY_STORE = '1';
      delete env.REDIS_URL;
    } else {
      env.REDIS_URL = 'redis://localhost:6399';
    }

    const proc = spawn(cmd, args, {
      cwd: opts.cwd || this.root,
      env,
      stdio: 'pipe',
      windowsHide: true,
    });

    proc.on('error', (err) => {
      log(`[${name}] spawn error: ${err.message}`);
    });

    proc.on('exit', (code, signal) => {
      log(`[${name}] exited: code=${code} signal=${signal}`);
    });

    proc.stdout?.on('data', (d) => log(`[${name}] ${d.toString().trim()}`));
    proc.stderr?.on('data', (d) => log(`[${name}] ERR: ${d.toString().trim()}`.slice(0, 500)));

    this.procs[name] = proc;
  }

  _isPortOpen(port) {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(300);
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => resolve(false));
      sock.once('timeout', () => { sock.destroy(); resolve(false); });
      sock.connect(port, '127.0.0.1');
    });
  }

  async _waitForPort(port, label) {
    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      if (await this._isPortOpen(port)) {
        this.onStatus(`${label} ready on port ${port}`);
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`${label} did not start within ${MAX_WAIT_MS / 1000}s (port ${port})`);
  }

  async stopAll() {
    for (const [name, proc] of Object.entries(this.procs)) {
      if (proc && !proc.killed) {
        console.log(`[desktop] stopping ${name}...`);
        proc.kill('SIGTERM');
      }
    }
    this.procs = {};
  }
}

module.exports = ServiceManager;
