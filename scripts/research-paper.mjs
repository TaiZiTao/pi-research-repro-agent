#!/usr/bin/env node
import { executeResearchCli } from "../src/agent-host/research/cli.ts";

process.exitCode = await executeResearchCli(process.argv.slice(2));
