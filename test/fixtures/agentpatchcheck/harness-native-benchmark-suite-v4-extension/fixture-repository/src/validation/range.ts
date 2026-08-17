export function isPort(value: number): boolean {
	return value >= 1 && value < 65535;
}
