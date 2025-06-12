#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: node filesystem.js [allowed-directory...]");
  process.exit(1);
}

function normalizePath(p) {
  return path.normalize(p);
}

function expandHome(filepath) {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

// Store allowed directories in normalized form
const allowedDirectories = args.map(dir =>
  normalizePath(path.resolve(expandHome(dir)))
);

// Validate that all directories exist and are accessible
// This block needs to be outside the main execution flow if using top-level await
// For now, I'll keep it as is, assuming Node.js version supports top-level await or it's wrapped.
// If issues arise, it might need to be moved into runServer().
await Promise.all(args.map(async (dir) => {
  try {
    const stats = await fs.stat(expandHome(dir));
    if (!stats.isDirectory()) {
      console.error(`Error: ${dir} is not a directory`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error accessing directory ${dir}:`, error);
    process.exit(1);
  }
}));

// Security utilities
async function validatePath(requestedPath) {
  const expandedPath = expandHome(requestedPath);
  const absolute = path.isAbsolute(expandedPath) ? path.resolve(expandedPath) : path.resolve(process.cwd(), expandedPath);
  const normalizedRequested = normalizePath(absolute);

  // Check if path is within allowed directories
  if (!allowedDirectories.some(dir => normalizedRequested.startsWith(dir))) {
    throw new Error(`Access denied - path outside allowed directories: ${absolute} not in ${allowedDirectories.join(', ')}`);
  }

  // Handle symlinks by checking their real path
  try {
    const realPath = await fs.realpath(absolute);
    const normalizedReal = normalizePath(realPath);
    const isRealPathAllowed = allowedDirectories.some(dir => normalizedReal.startsWith(dir));

    if (!isRealPathAllowed) {
      throw new Error("Access denied - symlink target outside allowed directories");
    }

    return realPath;
  } catch (error) {
    // For new files that don't exist yet, verify parent directory
    const parentDir = path.dirname(absolute);

    try {
      const realParentPath = await fs.realpath(parentDir);
      const normalizedParent = normalizePath(realParentPath);
      const isParentAllowed = allowedDirectories.some(dir => normalizedParent.startsWith(dir));

      if (!isParentAllowed) {
        throw new Error("Access denied - parent directory outside allowed directories");
      }

      return absolute;
    } catch {
      throw new Error(`Parent directory does not exist: ${parentDir}`);
    }
  }
}

// Schema definitions
const ReadFileLinesArgsSchema = z.object({
  path: z.string(),
  offset: z.number().int().min(0).describe('The starting line number (0-indexed).'),
  limit: z.number().int().min(1).describe('The maximum number of lines to read.'),
});

const AppendFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const ToolInputSchema = ToolSchema.shape.inputSchema;

// Tool implementations
async function readFileLinesHandler(args) {
  const { path: filePath, offset, limit } = args;

  const resolvedPath = await validatePath(filePath);

  try {
    const fileContent = await fs.readFile(resolvedPath, 'utf8');
    const lines = fileContent.split(/\r?\n/);
    const selectedLines = lines.slice(offset, offset + limit);

    return { content: selectedLines.join('\n') };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { error: 'File not found.' };
    }

    return { error: error.message };
  }
}

async function appendFileHandler(args) {
  const { path: filePath, content } = args;

  const resolvedPath = await validatePath(filePath);

  try {
    await fs.appendFile(resolvedPath, content, 'utf8');
    return { success: true, message: `Successfully appended to ${filePath}` };
  } catch (error) {
    return { error: error.message };
  }
}

const server = new Server(
  {
    name: "read_files_server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "read_file_lines",
        description:
          "Reads a specified number of lines from a file, given a file path, line offset, and line limit. " +
          "Only works within allowed directories.",
        inputSchema: zodToJsonSchema(ReadFileLinesArgsSchema),
      },
      {
        name: "append_file",
        description:
          "Appends content to a file. If the file does not exist, it will be created. " +
          "Only works within allowed directories.",
        inputSchema: zodToJsonSchema(AppendFileArgsSchema),
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "read_file_lines": {
        const parsed = ReadFileLinesArgsSchema.safeParse(args);

        if (!parsed.success) {
          throw new Error(`Invalid arguments for read_file_lines: ${parsed.error}`);
        }

        const result = await readFileLinesHandler(parsed.data);

        return {
          content: [{ type: "text", text: result.content || result.error }],
          isError: !!result.error,
        };
      }

      case "append_file": {
        const parsed = AppendFileArgsSchema.safeParse(args);

        if (!parsed.success) {
          throw new Error(`Invalid arguments for append_file: ${parsed.error}`);
        }

        const result = await appendFileHandler(parsed.data);

        return {
          content: [{ type: "text", text: result.message || result.error }],
          isError: !!result.error,
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

async function runServer() {
  await server.connect(new StdioServerTransport());

  console.info("MCP Read Files Server running on stdio");
  console.info("Allowed directories:", allowedDirectories);
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
