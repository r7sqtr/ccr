#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as nodeTty from 'node:tty';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ESC = '\x1b';
const COLORS = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
  rev: `${ESC}[7m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  cyan: `${ESC}[36m`,
  red: `${ESC}[31m`,
  gray: `${ESC}[90m`,
};

function getClaudeHome() {
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return path.join(os.homedir(), '.claude');
}

function parseArgs(argv) {
  const opts = {
    cwdFilter: null,
    includeRunning: true,
    excludeRunning: false,
    includeAgents: false,
    sort: 'mtime',
    limit: null,
    days: null,
    query: '',
    fork: false,
    dryRun: false,
    json: false,
    noPreview: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--here':
        opts.cwdFilter = process.cwd();
        break;
      case '--cwd':
        opts.cwdFilter = argv[++i];
        break;
      case '--exclude-running':
      case '--no-running':
        opts.excludeRunning = true;
        break;
      case '--include-agents':
        opts.includeAgents = true;
        break;
      case '--sort':
        opts.sort = argv[++i];
        break;
      case '--limit':
        opts.limit = parseInt(argv[++i], 10);
        break;
      case '--days':
        opts.days = parseInt(argv[++i], 10);
        break;
      case '--query':
      case '-q':
        opts.query = argv[++i] ?? '';
        break;
      case '--fork':
      case '--fork-session':
        opts.fork = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--no-preview':
        opts.noPreview = true;
        break;
      default:
        if (a.startsWith('-')) {
          eprintln(`${COLORS.yellow}unknown option: ${a}${COLORS.reset}`);
        } else if (!opts.query) {
          opts.query = a;
        }
    }
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`ccr — Claude Code cross-project session resumer

Usage: ccr [query] [options]

Browse Claude Code sessions across ALL working directories, pick one,
and resume it (\`claude --resume\`) in its original directory.

Options:
  [query]                Initial fuzzy filter (also --query/-q <s>)
  --here                 Only sessions under the current directory
  --cwd <path>           Only sessions under <path> (prefix match)
  --exclude-running      Hide sessions that look currently running
  --include-agents       Include sub-agent sessions (hidden by default)
  --sort mtime|created|cwd   Sort order (default: mtime, newest first)
  --limit <N>            Show at most N sessions
  --days <N>             Only sessions updated within the last N days
  --fork                 Resume with --fork-session (new session id)
  --dry-run              Print the resume command instead of running it
  --json                 Print collected sessions as JSON and exit
  --no-preview           Disable the preview pane in the picker
  -h, --help             Show this help

Keys (picker):
  type           filter        ↑/↓ or Ctrl-P/N   move
  Enter          resume         Esc / Ctrl-C       cancel
  Ctrl-U         clear query    Ctrl-F             toggle --fork on resume
`);
}

function eprintln(s = '') {
  process.stderr.write(s + '\n');
}

// ---------- collection ----------

function listJsonlFiles(projectsDir) {
  const out = [];
  let dirents;
  try {
    dirents = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const dirPath = path.join(projectsDir, d.name);
    let files;
    try {
      files = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const filePath = path.join(dirPath, f.name);
      let st;
      try {
        st = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (st.size === 0) continue;
      out.push({
        filePath,
        dirName: d.name,
        fileStem: f.name.slice(0, -'.jsonl'.length),
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    }
  }
  return out;
}

function readHeadLines(filePath, { maxBytes = 64 * 1024, maxLines = 30 } = {}) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return [];
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.toString('utf8', 0, bytes);
    const lines = text.split('\n');
    // drop a trailing partial line only when we hit the byte cap
    if (bytes >= maxBytes && lines.length > 1) lines.pop();
    return lines.slice(0, maxLines);
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

function decodeDirName(dirName) {
  // Lossy: '/' was turned into '-', but so were '_' and '-' in the real path.
  // Use only as a fallback when no cwd field exists.
  const candidate = dirName.replace(/^-/, '/').replace(/-/g, '/');
  return candidate;
}

function extractFirstUserText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join(' ');
  }
  return '';
}

function cleanUserText(s) {
  if (!s) return '';
  let t = s;
  t = t.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, ' ');
  t = t.replace(/<command-message>[\s\S]*?<\/command-message>/g, ' ');
  t = t.replace(/<command-args>[\s\S]*?<\/command-args>/g, ' ');
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ');
  t = t.replace(/<command-name>\s*(\/?[^<]+?)\s*<\/command-name>/g, '$1');
  // strip any remaining xml-ish tags
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function parseSessionHead(file) {
  const lines = readHeadLines(file.filePath);
  const meta = {
    sessionId: file.fileStem,
    cwd: null,
    cwdSource: null, // 'field' | 'decoded'
    dirName: file.dirName,
    dirPath: path.dirname(file.filePath),
    filePath: file.filePath,
    slug: null,
    aiTitle: null,
    firstUserText: null,
    createdMs: null,
    gitBranch: null,
    version: null,
    mtimeMs: file.mtimeMs,
    size: file.size,
    isAgent: false,
    hasConversation: false,
    broken: false,
  };
  let parsedAny = false;
  let sawAgentName = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    parsedAny = true;
    if (obj.cwd && !meta.cwd) {
      meta.cwd = obj.cwd;
      meta.cwdSource = 'field';
    }
    if (obj.sessionId) meta.sessionId = obj.sessionId;
    if (obj.slug && !meta.slug) meta.slug = obj.slug;
    if (obj.gitBranch && !meta.gitBranch) meta.gitBranch = obj.gitBranch;
    if (obj.version && !meta.version) meta.version = obj.version;
    if (obj.type === 'ai-title' && obj.aiTitle && !meta.aiTitle) {
      meta.aiTitle = obj.aiTitle;
    }
    if (obj.type === 'agent-name' || obj.agentName) sawAgentName = true;
    if (obj.type === 'user' || obj.type === 'assistant') meta.hasConversation = true;
    if (
      obj.type === 'user' &&
      (obj.parentUuid === null || obj.parentUuid === undefined) &&
      obj.message &&
      meta.firstUserText === null
    ) {
      const raw = extractFirstUserText(obj.message.content);
      meta.firstUserText = cleanUserText(raw);
      if (obj.timestamp && !meta.createdMs) {
        const ms = Date.parse(obj.timestamp);
        if (!Number.isNaN(ms)) meta.createdMs = ms;
      }
    }
    if (obj.timestamp && !meta.createdMs) {
      const ms = Date.parse(obj.timestamp);
      if (!Number.isNaN(ms)) meta.createdMs = ms;
    }
  }
  if (!parsedAny) meta.broken = true;
  // sub-agent transcript: has agent-name and no real conversation turns
  meta.isAgent = sawAgentName && !meta.hasConversation;
  if (!meta.cwd) {
    const decoded = decodeDirName(meta.dirName);
    meta.cwd = fs.existsSync(decoded) ? decoded : decoded;
    meta.cwdSource = 'decoded';
  }
  meta.cwdExists = !!meta.cwd && fs.existsSync(meta.cwd);
  meta.label = normalizeLabel(meta);
  meta.haystack = [meta.cwd || '', meta.label, meta.slug || '', meta.sessionId]
    .join('  ')
    .toLowerCase();
  return meta;
}

function normalizeLabel(meta) {
  if (meta.aiTitle) return meta.aiTitle;
  if (meta.firstUserText) return meta.firstUserText;
  if (meta.slug) return meta.slug;
  return `(no title) ${meta.sessionId.slice(0, 8)}`;
}

function loadRuntimeStates(claudeHome) {
  const map = new Map();
  const dir = path.join(claudeHome, 'sessions');
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return map;
  }
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (obj.sessionId && obj.pid && isPidAlive(obj.pid)) {
        map.set(obj.sessionId, { status: obj.status, pid: obj.pid, cwd: obj.cwd });
      }
    } catch {
      // ignore
    }
  }
  return map;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function collectSessions(opts) {
  const claudeHome = getClaudeHome();
  const projectsDir = path.join(claudeHome, 'projects');
  const files = listJsonlFiles(projectsDir);
  const runtime = loadRuntimeStates(claudeHome);
  const metas = [];
  for (const f of files) {
    const meta = parseSessionHead(f);
    const rt = runtime.get(meta.sessionId);
    meta.isRunning = !!rt;
    meta.runningStatus = rt ? rt.status : null;
    metas.push(meta);
  }
  return metas;
}

// ---------- filter / sort ----------

function filterAndSort(metas, opts) {
  let out = metas.filter((m) => !m.broken);
  if (!opts.includeAgents) out = out.filter((m) => !m.isAgent);
  if (opts.excludeRunning) out = out.filter((m) => !m.isRunning);
  if (opts.cwdFilter) {
    const base = path.resolve(opts.cwdFilter);
    out = out.filter((m) => {
      if (!m.cwd) return false;
      const c = path.resolve(m.cwd);
      return c === base || c.startsWith(base + path.sep);
    });
  }
  if (opts.days != null && !Number.isNaN(opts.days)) {
    const cutoff = mtimeNow() - opts.days * 86400_000;
    out = out.filter((m) => m.mtimeMs >= cutoff);
  }
  const cmp = {
    mtime: (a, b) => b.mtimeMs - a.mtimeMs,
    created: (a, b) => (b.createdMs || b.mtimeMs) - (a.createdMs || a.mtimeMs),
    cwd: (a, b) => (a.cwd || '').localeCompare(b.cwd || '') || b.mtimeMs - a.mtimeMs,
  }[opts.sort] || ((a, b) => b.mtimeMs - a.mtimeMs);
  out.sort(cmp);
  if (opts.limit != null && !Number.isNaN(opts.limit)) out = out.slice(0, opts.limit);
  return out;
}

function mtimeNow() {
  // Date.now() avoidance is only for workflow scripts; here it's fine.
  return Date.now();
}

// ---------- formatting ----------

function charWidth(cp) {
  if (cp === 0) return 0;
  // East Asian Wide / Fullwidth ranges (approximate but covers CJK/kana/fullwidth)
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0));
  return w;
}

function truncate(s, maxW) {
  if (maxW <= 0) return '';
  if (displayWidth(s) <= maxW) return s;
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > maxW - 1) {
      out += '…';
      return out;
    }
    out += ch;
    w += cw;
  }
  return out;
}

function padRight(s, w) {
  const pad = w - displayWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

function shortenPath(p) {
  if (!p) return '?';
  const home = os.homedir();
  let s = p.startsWith(home) ? '~' + p.slice(home.length) : p;
  return s;
}

function relativeTime(ms) {
  const diff = mtimeNow() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo`;
  return `${Math.floor(mon / 12)}y`;
}

function absTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

// ---------- fuzzy ----------

function fuzzyMatch(query, text) {
  // AND of space-separated tokens, each a substring (case-insensitive).
  if (!query) return true;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((tok) => text.includes(tok));
}

// ---------- picker ----------

function runPicker(metas, opts) {
  const tty = openTty();
  if (!tty) return null;
  const state = {
    query: opts.query || '',
    cursor: 0,
    windowTop: 0,
    filtered: [],
    fork: opts.fork,
  };

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      tty.write(`${ESC}[?25h`); // show cursor
      tty.write(`${ESC}[?1049l`); // leave alt screen
    } catch {}
    try {
      if (tty.input.isTTY) tty.input.setRawMode(false);
    } catch {}
    try {
      tty.input.pause();
    } catch {}
    closeTty(tty);
  };

  process.on('exit', cleanup);
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    tty.input.setRawMode(true);
  } catch {}
  tty.input.resume();
  tty.input.setEncoding('utf8');
  tty.write(`${ESC}[?1049h`); // enter alt screen
  tty.write(`${ESC}[?25l`); // hide cursor

  const applyFilter = () => {
    state.filtered = [];
    for (let i = 0; i < metas.length; i++) {
      if (fuzzyMatch(state.query, metas[i].haystack)) state.filtered.push(i);
    }
    if (state.cursor >= state.filtered.length) state.cursor = Math.max(0, state.filtered.length - 1);
    if (state.cursor < 0) state.cursor = 0;
  };

  const getSize = () => {
    const cols = tty.output.columns || process.stdout.columns || 80;
    const rows = tty.output.rows || process.stdout.rows || 24;
    return { cols, rows };
  };

  const render = () => {
    const { cols, rows } = getSize();
    const showPreview = !opts.noPreview && cols >= 100;
    const listW = showPreview ? Math.floor(cols * 0.55) : cols;
    const previewX = listW + 2;
    const previewW = cols - previewX;

    let buf = `${ESC}[H${ESC}[2J`; // home + clear

    // header line
    const forkTag = state.fork ? ` ${COLORS.yellow}[fork]${COLORS.reset}` : '';
    const count = `${COLORS.gray}${state.filtered.length}/${metas.length}${COLORS.reset}`;
    buf += `${COLORS.cyan}❯${COLORS.reset} ${state.query}${COLORS.dim}▏${COLORS.reset}  ${count}${forkTag}\n`;
    buf += `${COLORS.gray}${'─'.repeat(Math.min(cols, listW))}${COLORS.reset}\n`;

    const headerRows = 2;
    const pageRows = Math.max(1, rows - headerRows - 1);

    // scroll window
    if (state.cursor < state.windowTop) state.windowTop = state.cursor;
    if (state.cursor >= state.windowTop + pageRows) state.windowTop = state.cursor - pageRows + 1;

    const visible = state.filtered.slice(state.windowTop, state.windowTop + pageRows);
    const lines = [];
    visible.forEach((mi, idx) => {
      const m = metas[mi];
      const selected = state.windowTop + idx === state.cursor;
      const marker = selected ? `${COLORS.cyan}❯${COLORS.reset}` : ' ';
      const runDot = m.isRunning
        ? `${COLORS.green}●${COLORS.reset}`
        : m.cwdExists
        ? ' '
        : `${COLORS.red}⚠${COLORS.reset}`;
      const rel = padRight(relativeTime(m.mtimeMs), 4);
      // Fixed columns: marker(1) runDot(1) space(1) rel(4) space(1) cwd 2-spaces label
      const fixed = 1 + 1 + 1 + 4 + 1 + 2;
      const budget = Math.max(10, listW - 1 - fixed);
      const cwdStr = truncate(shortenPath(m.cwd), Math.min(Math.floor(budget * 0.4), budget - 8));
      const labelW = Math.max(6, budget - displayWidth(cwdStr));
      const label = truncate(m.label, labelW);
      let row = `${marker}${runDot} ${COLORS.gray}${rel}${COLORS.reset} ${COLORS.dim}${cwdStr}${COLORS.reset}  ${label}`;
      if (selected) row = `${COLORS.bold}${row}${COLORS.reset}`;
      lines.push(row);
    });
    buf += lines.join('\n');

    // preview pane (drawn with absolute cursor positioning)
    if (showPreview && state.filtered.length > 0) {
      const m = metas[state.filtered[state.cursor]];
      const pv = buildPreview(m, previewW);
      let py = 1;
      for (const pl of pv.slice(0, rows - 1)) {
        buf += `${ESC}[${py};${previewX}H${pl}`;
        py++;
      }
    }

    tty.write(buf);
  };

  applyFilter();

  return new Promise((resolve) => {
    const finish = (result) => {
      try {
        tty.input.removeListener('data', onData);
      } catch {}
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('exit', cleanup);
      cleanup();
      resolve(result);
    };

    const onResize = () => render();
    tty.output.on?.('resize', onResize);

    const onData = (data) => {
      // handle possibly batched input
      let i = 0;
      while (i < data.length) {
        const rest = data.slice(i);
        if (rest[0] === ESC) {
          if (rest.startsWith(`${ESC}[A`) || rest.startsWith(`${ESC}OA`)) {
            move(-1);
            i += 3;
            continue;
          }
          if (rest.startsWith(`${ESC}[B`) || rest.startsWith(`${ESC}OB`)) {
            move(1);
            i += 3;
            continue;
          }
          if (rest.length === 1) {
            // bare ESC -> cancel
            return finish(null);
          }
          // unknown escape seq: skip the CSI/SS3 chunk
          i += rest.length;
          continue;
        }
        const ch = rest[0];
        const code = ch.charCodeAt(0);
        if (ch === '\r' || ch === '\n') {
          if (state.filtered.length === 0) return finish(null);
          const m = metas[state.filtered[state.cursor]];
          return finish({ meta: m, fork: state.fork });
        }
        if (code === 3 || code === 7) return finish(null); // Ctrl-C / Ctrl-G
        if (code === 16) {
          move(-1);
          i += 1;
          continue;
        } // Ctrl-P
        if (code === 14) {
          move(1);
          i += 1;
          continue;
        } // Ctrl-N
        if (code === 21) {
          state.query = '';
          applyFilter();
          render();
          i += 1;
          continue;
        } // Ctrl-U
        if (code === 6) {
          state.fork = !state.fork;
          render();
          i += 1;
          continue;
        } // Ctrl-F
        if (code === 127 || code === 8) {
          state.query = [...state.query].slice(0, -1).join('');
          applyFilter();
          render();
          i += 1;
          continue;
        }
        if (code < 32) {
          i += 1;
          continue;
        }
        // printable (consume one full code point)
        const cp = rest.codePointAt(0);
        const chr = String.fromCodePoint(cp);
        state.query += chr;
        applyFilter();
        render();
        i += chr.length;
      }
    };

    const move = (delta) => {
      if (state.filtered.length === 0) return;
      state.cursor = (state.cursor + delta + state.filtered.length) % state.filtered.length;
      render();
    };

    tty.input.on('data', onData);
    render();
  });
}

function buildPreview(m, width) {
  const lines = [];
  const wrap = (s) => wrapText(s, width);
  lines.push(`${COLORS.bold}${truncate(m.label, width)}${COLORS.reset}`);
  lines.push('');
  lines.push(`${COLORS.cyan}cwd${COLORS.reset}  ${truncate(shortenPath(m.cwd), width - 5)}`);
  if (!m.cwdExists) lines.push(`${COLORS.red}     (directory no longer exists)${COLORS.reset}`);
  if (m.gitBranch) lines.push(`${COLORS.cyan}git${COLORS.reset}  ${truncate(m.gitBranch, width - 5)}`);
  lines.push(`${COLORS.cyan}id ${COLORS.reset}  ${COLORS.gray}${m.sessionId}${COLORS.reset}`);
  if (m.slug) lines.push(`${COLORS.cyan}slug${COLORS.reset} ${COLORS.gray}${truncate(m.slug, width - 6)}${COLORS.reset}`);
  lines.push(`${COLORS.cyan}time${COLORS.reset} ${absTime(m.mtimeMs)}  ${COLORS.gray}(${relativeTime(m.mtimeMs)})${COLORS.reset}`);
  if (m.isRunning) lines.push(`${COLORS.green}● running${m.runningStatus ? ` (${m.runningStatus})` : ''}${COLORS.reset}`);
  lines.push('');
  lines.push(`${COLORS.gray}${'─'.repeat(Math.max(0, Math.min(width, 40)))}${COLORS.reset}`);
  const body = m.firstUserText || m.aiTitle || '(no opening message captured)';
  for (const w of wrap(body)) lines.push(`${COLORS.dim}${w}${COLORS.reset}`);
  return lines;
}

function wrapText(s, width) {
  const out = [];
  let line = '';
  let w = 0;
  for (const ch of s) {
    if (ch === '\n') {
      out.push(line);
      line = '';
      w = 0;
      continue;
    }
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > width) {
      out.push(line);
      line = ch;
      w = cw;
    } else {
      line += ch;
      w += cw;
    }
  }
  if (line) out.push(line);
  return out;
}

// ---------- tty ----------

function openTty() {
  try {
    const path0 = '/dev/tty';
    const inFd = fs.openSync(path0, 'r');
    const outFd = fs.openSync(path0, 'w');
    const input = new nodeTty.ReadStream(inFd);
    const output = new nodeTty.WriteStream(outFd);
    return {
      input,
      output,
      inFd,
      outFd,
      write: (s) => output.write(s),
    };
  } catch {
    // fallback to process std streams if they are TTYs
    if (process.stdin.isTTY && process.stdout.isTTY) {
      return {
        input: process.stdin,
        output: process.stdout,
        inFd: null,
        outFd: null,
        write: (s) => process.stdout.write(s),
      };
    }
    return null;
  }
}

function closeTty(t) {
  try {
    if (t.inFd != null) fs.closeSync(t.inFd);
  } catch {}
  try {
    if (t.outFd != null) fs.closeSync(t.outFd);
  } catch {}
}

// ---------- launch ----------

function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const which = spawnSync('command', ['-v', 'claude'], { shell: '/bin/zsh', encoding: 'utf8' });
  if (which.status === 0 && which.stdout) {
    const p = which.stdout.trim().split('\n')[0];
    if (p && fs.existsSync(p)) return p;
  }
  const candidates = [
    path.join(os.homedir(), '.local/bin/claude'),
    path.join(os.homedir(), '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'claude';
}

function launchResume(meta, opts) {
  const args = ['--resume', meta.sessionId];
  if (opts.fork) args.push('--fork-session');

  if (opts.dryRun) {
    process.stdout.write(`cd ${quote(meta.cwd)} && claude ${args.join(' ')}\n`);
    return 0;
  }

  if (!meta.cwdExists) {
    eprintln(`${COLORS.red}error:${COLORS.reset} directory does not exist: ${meta.cwd}`);
    eprintln(`The session's working directory was removed; cannot resume in place.`);
    return 1;
  }

  const bin = resolveClaudeBin();
  const child = spawn(bin, args, { cwd: meta.cwd, stdio: 'inherit' });

  return new Promise((resolve) => {
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        eprintln(`${COLORS.red}error:${COLORS.reset} could not find the \`claude\` binary.`);
        eprintln(`Run it manually:`);
        eprintln(`  cd ${quote(meta.cwd)} && claude ${args.join(' ')}`);
      } else {
        eprintln(`${COLORS.red}error:${COLORS.reset} ${err.message}`);
      }
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

function quote(s) {
  if (!s) return "''";
  return /[^A-Za-z0-9_@%+=:,.\/~-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}

// ---------- plain (non-tty) output ----------

function printPlain(metas, opts) {
  if (metas.length === 0) {
    eprintln('No sessions found.');
    return;
  }
  for (const m of metas) {
    const run = m.isRunning ? '●' : m.cwdExists ? ' ' : '⚠';
    const rel = padRight(relativeTime(m.mtimeMs), 4);
    process.stdout.write(
      `${run} ${rel}  ${m.sessionId}  ${shortenPath(m.cwd)}  ${m.label}\n`,
    );
  }
}

// ---------- main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }

  const all = collectSessions(opts);
  const metas = filterAndSort(all, opts);

  const isTty = process.stdout.isTTY && (process.stdin.isTTY || fs.existsSync('/dev/tty'));

  // Non-interactive paths (piped output, --json, or no TTY): apply the query
  // as a static filter and emit a plain listing — there is nothing to pick.
  if (!isTty || opts.json) {
    const shown = opts.query
      ? metas.filter((m) => fuzzyMatch(opts.query, m.haystack))
      : metas;
    if (opts.json) {
      process.stdout.write(JSON.stringify(shown, null, 2) + '\n');
      return 0;
    }
    if (shown.length === 0) {
      eprintln('No matching sessions found.');
      return 1;
    }
    printPlain(shown, opts);
    return 0;
  }

  if (metas.length === 0) {
    eprintln('No matching sessions found.');
    return 1;
  }

  const picked = await runPicker(metas, opts);
  if (!picked) {
    eprintln('Cancelled.');
    return 130;
  }
  return await launchResume(picked.meta, { ...opts, fork: picked.fork });
}

export {
  parseArgs,
  cleanUserText,
  extractFirstUserText,
  decodeDirName,
  normalizeLabel,
  displayWidth,
  truncate,
  fuzzyMatch,
  relativeTime,
  quote,
  filterAndSort,
};

function isInvokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    // Node resolves symlinks for import.meta.url but not for argv[1];
    // compare against the real path so `ccr` via a symlink still runs main().
    const real = fs.realpathSync(process.argv[1]);
    return import.meta.url === pathToFileURL(real).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

const invokedDirectly = isInvokedDirectly();

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((err) => {
      eprintln(`${COLORS.red}fatal:${COLORS.reset} ${err && err.stack ? err.stack : err}`);
      process.exitCode = 1;
    });
}
