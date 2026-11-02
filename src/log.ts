export function log(text: string) {
	return console.log(`${text}`)
}

export function colorGreen(s: string) {
	return `\x1b[32m${s}\x1b[0m`
}

export function colorPrimary(s: string) {
	return `\x1b[38;2;124;102;255m${s}\x1b[0m`
}

export function colorYellow(s: string) {
	return `\x1b[33m${s}\x1b[0m`
}

export function colorDim(s: string) {
	return `\x1b[2m${s}\x1b[0m`
}
