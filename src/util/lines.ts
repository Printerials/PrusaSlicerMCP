import { createReadStream } from "node:fs";

/**
 * The lines of a text file, streamed, without line terminators ("\r\n" or "\n").
 * Not readline: in Node 24 its async iterator throws ERR_USE_AFTER_CLOSE when the loop body
 * awaits (a write waiting for "drain") while the input ends. A stream's own iterator does not.
 */
export async function* readLines(path: string): AsyncGenerator<string> {
  let rest = "";
  for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 })) {
    const text = rest + (chunk as string);
    let start = 0;
    for (let nl = text.indexOf("\n", start); nl !== -1; nl = text.indexOf("\n", start)) {
      const end = nl > start && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
      yield text.slice(start, end);
      start = nl + 1;
    }
    rest = text.slice(start);
  }
  if (rest !== "") yield rest.endsWith("\r") ? rest.slice(0, -1) : rest;
}
