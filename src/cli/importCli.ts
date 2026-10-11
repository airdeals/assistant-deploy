import { readFile } from "node:fs/promises";
import { createDataSource } from "../db/dataSource.js";
import { importFiles, type ImportFormat } from "../importer.js";

/**
 * CLI-вход импорта:
 *   npm run import -- --format=wa --account=acc-1 --file=export.txt
 *   npm run import -- --format=tg --account=tg-1 --file=result.json [--own-sender=user999]
 *   флаги: --chat=<externalChatId> --own-name=... --own-number=... (для wa)
 */

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1] as string] = m[2] as string;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const format = args.format as ImportFormat | undefined;
  const account = args.account;
  const file = args.file;
  if ((format !== "wa" && format !== "tg") || !account || !file) {
    console.error("usage: --format=wa|tg --account=<accountId> --file=<path> [--chat=..] [--own-name=..] [--own-number=..] [--own-sender=..]");
    process.exitCode = 1;
    return;
  }
  const content = await readFile(file, "utf8");
  const ds = createDataSource();
  try {
    const report = await importFiles(ds, {
      accountId: account,
      format,
      files: [
        {
          content,
          ...(args.chat ? { chatExternalId: args.chat } : {}),
          ...(format === "wa"
            ? { waOptions: { ownName: args["own-name"], ownNumber: args["own-number"] } }
            : {}),
          ...(format === "tg" ? { tgOptions: { ownSenderId: args["own-sender"] } } : {}),
        },
      ],
      onProgress: (p) => console.error(`progress: ${p.chatExternalId} ${p.done}/${p.total}`),
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await ds.close();
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
