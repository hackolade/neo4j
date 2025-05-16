const ip = require('ip');

//@see https://en.wikipedia.org/wiki/IPv6_address
// Literal IPv6 addresses in resources (URLs):
// ------------------------------------------------
// Colon (:) characters in IPv6 addresses may conflict with the established syntax of resource identifiers,
// such as URIs and URLs. The colon is conventionally used to terminate the host path before a port number.[10]
// To alleviate this conflict, literal IPv6 addresses are enclosed in square brackets in such resource identifiers;
// When the URL doesn't conatoin the port the notation is
//      http://[2001:db8:85a3:8d3:1319:8a2e:370:7348]/
// When the URL also contains a port number the notation is:
//      https://[2001:db8:85a3:8d3:1319:8a2e:370:7348]:443/
function escapeV6IpForURL({ host }) {
	// If the host is already URL compatible then the ip lib will return false
	// > ip.isV6Format('[::1]')
	// false
	// If the host is a proper ipv6 ip then the `new URL(host)` will fail with Uncaught TypeError: Invalid URL
	// code: 'ERR_INVALID_URL',
	// !ip.isV4Format(host) check required because isV6Format returns true for ipv4 address because of backward compatibility

	if (ip.isV6Format(host) && !ip.isV4Format(host)) {
		return `[${host}]`;
	}

	return host;
}

module.exports = {
	escapeV6IpForURL,
};
