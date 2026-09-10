import { main } from "./main";
export async function publicMain(args = process.argv.slice(2)): Promise<number> {
  return main(args.length ? args : ["folio"]);
}
if (import.meta.main) process.exitCode = await publicMain();
