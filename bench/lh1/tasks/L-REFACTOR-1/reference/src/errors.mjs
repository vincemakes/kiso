/** The one error type: `code` is the process exit code the CLI maps it to. */
export class StatzError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}
