#!/usr/bin/env node

import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { execSync, spawn } from "child_process";

// ── Config ──────────────────────────────────────────────────────────────────
const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const PAGE_SIZE = 15; // rows visible at once

// ── ANSI helpers ────────────────────────────────────────────────────────────
const ESC = "\x1b";
const CSI = `${ESC}[`;
const clear = () => process.stdout.write(`${CSI}2J${CSI}H`);
const moveTo = (r, c) => process.stdout.write(`${CSI}${r};${c}H`);
const bold = (s) => `${CSI}1m${s}${CSI}0m`;
const dim = (s) => `${CSI}2m${s}${CSI}0m`;
const inverse = (s) => `${CSI}7m${s}${CSI}0m`;
const cyan = (s) => `${CSI}36m${s}${CSI}0m`;
const yellow = (s) => `${CSI}33m${s}${CSI}0m`;
const green = (s) => `${CSI}32m${s}${CSI}0m`;
const gray = (s) => `${CSI}90m${s}${CSI}0m`;
const hideCursor = () => process.stdout.write(`${CSI}?25l`);
const showCursor = () => process.stdout.write(`${CSI}?25h`);

// ── Scan sessions ───────────────────────────────────────────────────────────
function scanSessions() {
  const sessions = [];

  if (!fs.existsSync(PROJECTS_DIR)) {
    console.error("No projects directory found at", PROJECTS_DIR);
    process.exit(1);
  }

  const projectDirs = fs.readdirSync(PROJECTS_DIR);

  for (const projDir of projectDirs) {
    const projPath = path.join(PROJECTS_DIR, projDir);
    if (!fs.statSync(projPath).isDirectory()) continue;

    // Derive a human-readable project name from the directory name
    // e.g. "-Users-heeyounglee-Documents-multiagent-framework" -> "multiagent-framework"
    const projectName = deriveProjectName(projDir);

    const files = fs.readdirSync(projPath);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

    for (const jsonlFile of jsonlFiles) {
      const sessionId = jsonlFile.replace(".jsonl", "");
      const filePath = path.join(projPath, jsonlFile);

      try {
        const stat = fs.statSync(filePath);
        const { firstPrompt, lastPrompt, cwd } = extractSessionInfo(filePath);

        sessions.push({
          sessionId,
          projectName,
          projectDir: projDir,
          filePath,
          cwd: cwd || null,
          modifiedAt: stat.mtime,
          sizeKB: Math.round(stat.size / 1024),
          preview: lastPrompt || firstPrompt || "(no preview)",
        });
      } catch {
        // skip unreadable files
      }
    }
  }

  // Sort by most recent first
  sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return sessions;
}

function deriveProjectName(dirName) {
  // Remove leading dash, split by dash, take meaningful trailing segments
  const parts = dirName.replace(/^-/, "").split("-");
  // Find the index after "Documents" or similar common prefixes
  const docIdx = parts.lastIndexOf("Documents");
  if (docIdx >= 0 && docIdx < parts.length - 1) {
    return parts.slice(docIdx + 1).join("-");
  }
  // Fallback: last 2-3 meaningful segments
  return parts.slice(-2).join("-");
}

function extractSessionInfo(filePath) {
  let firstPrompt = null;
  let lastPrompt = null;
  let cwd = null;

  try {
    // Read file line by line (not all at once for large files)
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Get cwd from any entry that has it (first line is often a metadata header)
        if (entry.cwd && !cwd) {
          cwd = entry.cwd;
        }

        // Use last-prompt type for a clean preview
        if (entry.type === "last-prompt" && entry.lastPrompt) {
          lastPrompt = entry.lastPrompt.slice(0, 200);
        }

        // Extract first user text message
        if (entry.type === "user" && !firstPrompt) {
          const msg = entry.message;
          if (msg && msg.content) {
            if (typeof msg.content === "string") {
              firstPrompt = msg.content.slice(0, 200);
            } else if (Array.isArray(msg.content)) {
              for (const item of msg.content) {
                if (item.type === "text" && item.text) {
                  firstPrompt = item.text.slice(0, 200);
                  break;
                }
              }
            }
          }
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // file read error
  }

  return { firstPrompt, lastPrompt, cwd };
}

// ── Format helpers ──────────────────────────────────────────────────────────
function formatDate(date) {
  const now = new Date();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncate(str, maxLen) {
  if (!str) return "";
  // Clean up whitespace and newlines
  const clean = str.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 1) + "\u2026";
}

// ── TUI ─────────────────────────────────────────────────────────────────────
function runTUI(sessions) {
  if (sessions.length === 0) {
    console.log("No sessions found in", PROJECTS_DIR);
    process.exit(0);
  }

  let cursor = 0;
  let scrollOffset = 0;
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 30;
  const visibleRows = Math.min(PAGE_SIZE, rows - 6);

  function render() {
    clear();
    moveTo(1, 1);

    const title = ` Claude Sessions Browser `;
    process.stdout.write(
      bold(cyan(title)) +
        gray(`  (${sessions.length} sessions)`) +
        "\n"
    );
    process.stdout.write(
      dim(
        "  Arrow keys: navigate | Enter: resume | q: quit | /: search\n"
      )
    );
    process.stdout.write(dim("─".repeat(Math.min(cols, 120))) + "\n");

    for (let i = 0; i < visibleRows; i++) {
      const idx = scrollOffset + i;
      if (idx >= sessions.length) {
        process.stdout.write("\n");
        continue;
      }

      const s = sessions[idx];
      const isSelected = idx === cursor;
      const prefix = isSelected ? " > " : "   ";

      const projectCol = truncate(s.projectName, 28).padEnd(28);
      const dateCol = formatDate(s.modifiedAt).padEnd(14);
      const sizeCol = `${s.sizeKB}KB`.padEnd(8);
      const previewMaxLen = Math.max(cols - 28 - 14 - 8 - 8, 20);
      const previewCol = truncate(s.preview, previewMaxLen);

      let line = `${prefix}${projectCol} ${dateCol} ${sizeCol} ${previewCol}`;

      if (isSelected) {
        // Pad to fill width for inverse highlight
        line = line.padEnd(Math.min(cols, 120));
        process.stdout.write(inverse(line) + "\n");
      } else {
        process.stdout.write(
          `${prefix}${cyan(projectCol)} ${yellow(dateCol)} ${gray(sizeCol)} ${dim(previewCol)}\n`
        );
      }
    }

    // Scrollbar indicator
    process.stdout.write(
      dim("─".repeat(Math.min(cols, 120))) + "\n"
    );

    const s = sessions[cursor];
    process.stdout.write(
      gray(`  Session: ${s.sessionId}\n`)
    );
    if (s.cwd) {
      process.stdout.write(gray(`  Dir:     ${s.cwd}\n`));
    }
  }

  // Set up input handling
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  hideCursor();
  render();

  let searchMode = false;
  let searchQuery = "";
  let filteredSessions = sessions;
  let allSessions = sessions;

  function applySearch() {
    if (!searchQuery) {
      filteredSessions = allSessions;
    } else {
      const q = searchQuery.toLowerCase();
      filteredSessions = allSessions.filter(
        (s) =>
          s.projectName.toLowerCase().includes(q) ||
          s.preview.toLowerCase().includes(q) ||
          s.sessionId.toLowerCase().includes(q)
      );
    }
    sessions = filteredSessions;
    cursor = 0;
    scrollOffset = 0;
  }

  process.stdin.on("keypress", (str, key) => {
    if (!key) return;

    if (searchMode) {
      if (key.name === "return" || key.name === "escape") {
        searchMode = false;
        render();
        return;
      }
      if (key.name === "backspace") {
        searchQuery = searchQuery.slice(0, -1);
        applySearch();
        render();
        // Show search bar
        moveTo(2, 1);
        process.stdout.write(
          `  ${green("Search:")} ${searchQuery}${CSI}K`
        );
        return;
      }
      if (str && str.length === 1 && !key.ctrl) {
        searchQuery += str;
        applySearch();
        render();
        moveTo(2, 1);
        process.stdout.write(
          `  ${green("Search:")} ${searchQuery}${CSI}K`
        );
        return;
      }
      return;
    }

    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      cleanup();
      process.exit(0);
    }

    if (str === "/") {
      searchMode = true;
      searchQuery = "";
      render();
      moveTo(2, 1);
      process.stdout.write(`  ${green("Search:")} ${CSI}K`);
      return;
    }

    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      if (cursor > 0) {
        cursor--;
        if (cursor < scrollOffset) scrollOffset = cursor;
      }
      render();
    } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
      if (cursor < sessions.length - 1) {
        cursor++;
        if (cursor >= scrollOffset + visibleRows)
          scrollOffset = cursor - visibleRows + 1;
      }
      render();
    } else if (key.name === "pageup") {
      cursor = Math.max(0, cursor - visibleRows);
      scrollOffset = Math.max(0, scrollOffset - visibleRows);
      render();
    } else if (key.name === "pagedown") {
      cursor = Math.min(sessions.length - 1, cursor + visibleRows);
      scrollOffset = Math.min(
        Math.max(0, sessions.length - visibleRows),
        scrollOffset + visibleRows
      );
      render();
    } else if (key.name === "return") {
      const selected = sessions[cursor];
      resumeSession(selected);
    }
  });

  function cleanup() {
    showCursor();
    clear();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.removeAllListeners("keypress");
    process.stdin.pause();
  }

  function resumeSession(session) {
    cleanup();

    console.log(
      `\nResuming session ${cyan(session.sessionId)} in ${session.cwd || "current directory"}...\n`
    );

    const args = ["--resume", session.sessionId];
    const cwd = session.cwd && fs.existsSync(session.cwd) ? session.cwd : process.cwd();

    const child = spawn("claude", args, {
      cwd,
      stdio: "inherit",
    });

    child.on("exit", (code) => {
      process.exit(code || 0);
    });

    child.on("error", (err) => {
      console.error("Failed to launch claude:", err.message);
      process.exit(1);
    });
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
console.log(dim("Scanning sessions..."));
const sessions = scanSessions();
runTUI(sessions);
