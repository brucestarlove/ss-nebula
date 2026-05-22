#!/usr/bin/env node
import { runNebulaCli } from '../cli/nebula-cli.mjs'

process.exitCode = await runNebulaCli(process.argv.slice(2))
