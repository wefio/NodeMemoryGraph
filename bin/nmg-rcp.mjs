#!/usr/bin/env node

import process from "node:process";

import { runRcpCli } from "../dist/rcp/cli/main.js";

process.exitCode = await runRcpCli(process.argv.slice(2));
