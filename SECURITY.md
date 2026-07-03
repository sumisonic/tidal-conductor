# Security

tidal-conductor listens for OSC over UDP with **no authentication**. Anyone who can reach the
listen port can move the knobs, and anyone who can reach Tidal's control listener can write
patterns into your session. The defaults keep both on `127.0.0.1`; only change
`AI_LISTEN_HOST` on a network you trust.

API keys for the `api` Brain are read from the environment (`.env` is gitignored). They are
never written to session logs.

To report a vulnerability, use GitHub's private vulnerability reporting on this repository
(Security tab, "Report a vulnerability") rather than a public issue. If that option is not
shown, open an issue that says only that you have a security report and how to reach you, and
the maintainer will get in touch.
