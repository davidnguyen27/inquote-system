import { parseArgs } from "node:util";
import { databaseUrl, loadLocalEnvironment } from "../../config/env.js";
import { Database } from "../../database/prisma.js";
import { HttpProblem } from "../../http/problem.js";
import { PasswordService } from "./password.service.js";
import { AdministratorProvisioningService } from "./provisioning.service.js";

// Only stdin accepts the password. Never echo it, place it in arguments, or log database errors.
async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 1024) throw new Error("Password input is too long.");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks)
      .toString("utf8")
      .replace(/\r?\n$/, "");
  }
  process.stderr.write("Password (hidden): ");
  const originalRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = Buffer.alloc(0);
    const finish = (error?: Error) => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("error", onError);
      process.stdin.setRawMode(originalRaw);
      process.stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value.toString("utf8"));
    };
    const onError = () => finish(new Error("Unable to read protected input."));
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3 || byte === 4) return finish(new Error("Cancelled."));
        if (byte === 13 || byte === 10) return finish();
        if (byte === 127 || byte === 8) {
          if (value.length) {
            let start = value.length - 1;
            while (start > 0 && (value[start]! & 0xc0) === 0x80) start--;
            value = value.subarray(0, start);
          }
        } else {
          value = Buffer.concat([value, Buffer.from([byte])]);
        }
        if (value.length > 1024)
          return finish(new Error("Password input is too long."));
      }
    };
    process.stdin.on("data", onData);
    process.stdin.on("error", onError);
  });
}

async function run(): Promise<void> {
  const args = parseArgs({
    options: { email: { type: "string" }, "display-name": { type: "string" } },
    allowPositionals: true,
  });
  const command = args.positionals[0];
  if (
    args.positionals.length !== 1 ||
    !["bootstrap", "reset"].includes(command ?? "") ||
    !args.values.email ||
    (command === "bootstrap" && !args.values["display-name"]) ||
    (command === "reset" && args.values["display-name"])
  ) {
    throw new Error(
      "Use bootstrap --email <email> --display-name <name>, or reset --email <email>; supply the password through protected stdin.",
    );
  }
  loadLocalEnvironment();
  const url = databaseUrl(process.env),
    passwords = new PasswordService(),
    password = await readPassword();
  passwords.validate(password);
  const database = new Database(url);
  try {
    const service = new AdministratorProvisioningService(database, passwords);
    const id =
      command === "bootstrap"
        ? await service.bootstrap(
            args.values.email,
            args.values["display-name"]!,
            password,
          )
        : await service.reset(args.values.email, password);
    process.stdout.write(`Administrator ${command} completed: ${id}\n`);
  } finally {
    await database.close();
  }
}
run().catch((error) => {
  // Arguments/configuration/policy failures are safe; unknown database/input errors remain generic.
  const message =
    error instanceof HttpProblem
      ? error.code
      : "Operator command failed. Check arguments, configuration and protected input.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
