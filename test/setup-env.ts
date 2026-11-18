// Keep the host's Git configuration out of the tests. Git reads extra config from
// GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n and GIT_CONFIG_PARAMETERS (what
// `git -c` sets), and code under test runs git with the test process's environment. A host
// that rewrites remote URLs that way (url.<base>.insteadOf) would otherwise change results.
for (const key of Object.keys(process.env)) {
  if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key)) delete process.env[key];
}
