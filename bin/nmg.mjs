#!/usr/bin/env node

import process from "node:process";

import { runCli } from "../dist/cli/main.js";

process.exitCode = await runCli(process.argv.slice(2));
