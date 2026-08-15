# Theme Focus Observer regression boundary

`public/theme-focus.js` observes `#app` with a child-list `MutationObserver`. Any enhancement invoked from that observer must be idempotent: it may only mutate text/markup when the resulting DOM differs from the current DOM.

This prevents an observer callback from repeatedly creating its own child-list mutations and starving browser painting. The contract test guards the known risky text writes and the theme-button markup update.
