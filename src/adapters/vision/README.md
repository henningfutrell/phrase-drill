# adapters/vision

Wraps the Claude vision API call used to import handwritten phrases.

Boundary: the only place that holds the API credential or issues the network
request. Exposes a small port the domain can call; never leaks HTTP/fetch types
outward.
