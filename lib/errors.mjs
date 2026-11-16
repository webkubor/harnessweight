// Return only bounded categories: upstream messages can contain credentials,
// account identifiers and request content, so never retain or publish them.
export function errorReason(status, type = "", message = "") {
  const text = `${type} ${message}`.slice(0, 8192).toLowerCase()
  if (/reply_loop|reasoning loop|ended this reply/.test(text)) return "replyLoop"
  if (/empty reply|answered nothing|no content/.test(text)) return "emptyReply"
  // A cut connection is a mid-reply failure only when the reply had already
  // started; before that it is a connection failure.
  if (status >= 200 && status < 400 && /connection lost|unexpected eof|econnreset|econnrefused|socket|stream .*(cut|closed|ended)|cut short/.test(text)) return "stream"
  if (/context[_ ]length|context window|too many tokens|maximum.*tokens/.test(text)) return "context"
  if (/insufficient[_ ]quota|quota.*exceed|credit|balance|billing/.test(text) || status === 402) return "quota"
  if (status === 429 || /rate[_ -]?limit|too many requests/.test(text)) return "rateLimit"
  if (status === 401 || status === 403 || /authentication|permission|invalid.*api.?key/.test(text)) return "auth"
  if (/model.*(not found|not supported|unavailable)|unsupported.*model/.test(text)) return "model"
  // A name that did not resolve is a DNS problem, and worth its own bucket: it
  // is the clearest sign that a local resolver, VPN or proxy is in the way.
  if (/getaddrinfo|enotfound|eai_again|no such host|name resolution|servfail/.test(text)) return "dns"
  if (status === 408 || status === 504 || /timeout|timed out|no first token|first token/.test(text)) return "timeout"
  // A gateway wraps a transport failure as 502 ("Post ...: unexpected EOF"),
  // and a client whose own proxy is down reports the same way ("proxyconnect
  // tcp: dial tcp 127.0.0.1:7890: connect: connection refused"). Read as an
  // application error they hide the one fact worth keeping: the path broke,
  // and in the second case it broke on this machine, not at the provider.
  if (status >= 500 && /unexpected eof|econnreset|econnrefused|connection refused|proxyconnect|dial tcp|no route to host|network is unreachable|socket.*closed|broken pipe|connection reset/.test(text)) return "network"
  if (status >= 500 || /internal server error/.test(text)) return "server"
  if (status === 400 || status === 404 || status === 422 || /invalid_request|invalid.argument/.test(text)) return "request"
  if (status === 0 && /connect|socket|network|dns|econn|fetch failed|eof|tls|reset|refused|abort|broken pipe/.test(text)) return "network"
  return "unknown"
}
