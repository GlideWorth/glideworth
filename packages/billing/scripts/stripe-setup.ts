#!/usr/bin/env node
import { createStripeClient, stripeGateway } from "../src/gateway/stripe.js";
import { runSetup } from "./setup.js";

const code = await runSetup(process.argv.slice(2), {
  env: process.env,
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  makeGateway: async (key) => stripeGateway(await createStripeClient(key)),
});
process.exitCode = code;
