import { readFileSync, writeFileSync } from "node:fs";
import { loadRhwp } from "./rhwpNode.js";
const Ctor = (await loadRhwp())!;
const doc:any = new Ctor(new Uint8Array(readFileSync(process.argv[2]!)));
writeFileSync(process.argv[3]!, Buffer.from(doc.exportHwpx()));
console.log("saved", process.argv[3]);
