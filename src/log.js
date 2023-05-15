export function log(text) {
	return console.log(`${text}`)
}

export function colorGreen(s) {
	return `\x1b[32m${s}\x1b[0m`
}

export function colorPrimary(s) {
	return `\x1b[38;2;124;102;255m${s}\x1b[0m`
}
