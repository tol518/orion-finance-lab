# Security Policy

Orion Finance Lab handles local service credentials, paper-account metadata, agent permissions, and financial research state. Do not include credentials, account identifiers, personal data, logs, databases, or private runtime configuration in an issue, pull request, screenshot, or fixture.

## Reporting a vulnerability

Use the repository's **Security** tab and choose **Report a vulnerability** to send details privately. Do not open a public issue for a suspected security problem.

Include the affected version or commit, the reachable entry point, reproduction conditions, impact, and any proposed mitigation. Use synthetic account and agent identifiers in all evidence.

## Supported scope

The current public code supports local paper trading and a read-only IBKR paper-account connection. Live-account routing and IBKR order submission are outside the supported security boundary.
