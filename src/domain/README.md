# domain

Pure domain core: phrase-drill entities, rules, and application logic.

Boundary: imports nothing from `adapters/`, `react`, `idb`, the DOM, or any browser
or network API. No I/O of any kind. Every dependency on the outside world is a
function parameter or an injected port, never an import.
