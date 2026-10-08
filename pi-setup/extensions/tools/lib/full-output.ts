/**
 * the complete output of one bash run: the file named in the model's
 * truncation marker, and the `output` codemode scripts receive.
 *
 * small output stays in memory and never touches disk. past SPILL_BYTES, or
 * when the caller asks (the model's view got truncated), everything is written
 * to a private temp file and later chunks are appended there.
 *
 * add() runs inside stream `data` handlers, where a throw is uncaught and
 * exits pi, so a filesystem failure is recorded rather than thrown.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const SPILL_BYTES = 256 * 1024;
/** scripts get at most this much, as head + tail around a marker, like pi's built-in bash. */
export const STRUCTURED_MAX_BYTES = 1024 * 1024;
/** a runaway command (`yes` for the full timeout) must not fill the disk. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

export type FinishedOutput = {
	output: string;
	/** `output` omits part of what the command printed */
	truncated: boolean;
	/** the file holding everything, when one was written */
	path?: string;
	/** the file stopped at MAX_FILE_BYTES; the command printed more */
	capped?: boolean;
	/** why the full output could not be kept */
	error?: string;
};

export class FullOutput {
	private chunks: string[] = [];
	private bytes = 0;
	private written = 0;
	private capped = false;
	private fd: number | undefined;
	private path: string | undefined;
	private error: string | undefined;

	constructor(
		private readonly spillBytes = SPILL_BYTES,
		private readonly maxFileBytes = MAX_FILE_BYTES,
	) {}

	add(text: string): void {
		if (this.error || !text) return;
		this.bytes += Buffer.byteLength(text);
		if (this.fd !== undefined) {
			this.write(text);
			return;
		}
		this.chunks.push(text);
		if (this.bytes > this.spillBytes) this.spill();
	}

	/** move the output to disk (idempotent); the path, or undefined if writing failed. */
	spill(): string | undefined {
		if (this.path || this.error) return this.path;
		let dir: string | undefined;
		try {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-"));
			const file = path.join(dir, "output.log");
			this.fd = fs.openSync(file, "w", 0o600);
			this.path = file;
		} catch (err: any) {
			if (dir) fs.rmSync(dir, { recursive: true, force: true });
			this.error = `could not create the full-output file: ${err.message}`;
			return undefined;
		}
		this.write(this.chunks.join(""));
		this.chunks = [];
		return this.path;
	}

	finish(): FinishedOutput {
		if (this.fd !== undefined) {
			try { fs.closeSync(this.fd); } catch { /* already closed */ }
			this.fd = undefined;
		}
		if (this.error) return { output: "", truncated: true, error: this.error };
		if (!this.path) return { output: this.chunks.join(""), truncated: false };

		try {
			return { ...this.readBack(this.path), ...(this.capped ? { capped: true, truncated: true } : {}) };
		} catch (err: any) {
			return { output: "", truncated: true, error: `could not read the full-output file ${this.path}: ${err.message}` };
		}
	}

	private readBack(file: string): FinishedOutput {
		const size = this.written;
		if (size <= STRUCTURED_MAX_BYTES) {
			return { output: fs.readFileSync(file, "utf8"), truncated: false, path: file };
		}
		const half = STRUCTURED_MAX_BYTES / 2;
		const fd = fs.openSync(file, "r");
		try {
			const head = Buffer.alloc(half);
			const tail = Buffer.alloc(half);
			fs.readSync(fd, head, 0, half, 0);
			fs.readSync(fd, tail, 0, half, size - half);
			const marker = `\n\n... [${size - STRUCTURED_MAX_BYTES} bytes omitted; full output in ${file}] ...\n\n`;
			return { output: head.toString("utf8") + marker + tail.toString("utf8"), truncated: true, path: file };
		} finally {
			fs.closeSync(fd);
		}
	}

	private write(text: string): void {
		if (this.capped) return;
		let buf = Buffer.from(text);
		if (this.written + buf.length > this.maxFileBytes) {
			buf = buf.subarray(0, this.maxFileBytes - this.written);
			this.capped = true;
		}
		try {
			let offset = 0;
			while (offset < buf.length) offset += fs.writeSync(this.fd!, buf, offset);
			this.written += buf.length;
		} catch (err: any) {
			this.error = `could not write the full-output file ${this.path}: ${err.message}`;
			try { fs.closeSync(this.fd!); } catch { /* best effort */ }
			this.fd = undefined;
			this.path = undefined;
		}
	}
}
