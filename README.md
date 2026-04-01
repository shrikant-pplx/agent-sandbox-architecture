# Agent Sandbox Architecture — Design Analysis

Complete design analysis of secure, scalable agent sandbox infrastructure, based on [Browser Use's architecture](https://x.com/larsencc/status/2027225210412470668) described by Larsen Cundric.

## What's Inside

- **Architecture Overview** — Evolution from AWS Lambda → Pattern 1 (Isolate the Tool) → Pattern 2 (Isolate the Agent)
- **Detailed Design** — Unikraft micro-VMs, control plane proxy, LLM proxying, presigned URL file sync, Gateway protocol
- **Architecture Diagrams** — ASCII diagrams of all architecture patterns, data flows, and hardening sequences
- **Comparative Analysis** — Browser Use vs Manus AI vs OpenAI Codex vs Claude Code vs Google GKE vs Devin
- **ZeroBoot Analysis** — Sub-millisecond VM sandboxes via copy-on-write forking ([zerobootdev/zeroboot](https://github.com/zerobootdev/zeroboot))
- **Alibaba OpenSandbox** — General-purpose Kubernetes-native sandbox platform ([alibaba/OpenSandbox](https://github.com/alibaba/OpenSandbox))
- **Isolation Technologies** — Docker vs gVisor vs Firecracker vs Unikraft vs ZeroBoot vs Kata Containers
- **STRIDE Threat Model** — Systematic threat analysis across Spoofing, Tampering, Repudiation, Information Disclosure, DoS, Elevation of Privilege
- **Attack Surface Map** — Visual mapping of attack vectors across sandbox, control plane, and external services
- **Top 10 Security Risks** — Prioritized by severity and likelihood with mitigations
- **Best Architecture Recommendations** — Defense-in-depth reference architecture with technology decision matrix
- **Implementation Roadmap** — 16-week phased plan from foundation to advanced security

## Tech Stack

Static HTML/CSS/JS site. No build step, no framework.

- **Fonts**: Inter + JetBrains Mono (Google Fonts)
- **Design**: Custom design tokens, dark/light mode, responsive sidebar navigation
- **Content**: All analysis content in semantic HTML sections

## Running Locally

```bash
# Any static file server works
python3 -m http.server 8000
# Open http://localhost:8000
```

## Sources

- [Browser Use: How We Built Secure, Scalable Agent Sandbox Infrastructure](https://browser-use.com/posts/two-ways-to-sandbox-agents)
- [ZeroBoot](https://github.com/zerobootdev/zeroboot) — Sub-millisecond VM sandboxes via CoW forking
- [Alibaba OpenSandbox](https://github.com/alibaba/OpenSandbox) — Sandbox platform for AI agents
- [Northflank: How to Sandbox AI Agents](https://northflank.com/blog/how-to-sandbox-ai-agents)
- [E2B: How Manus Uses E2B](https://e2b.dev/blog/how-manus-uses-e2b-to-provide-agents-with-virtual-computers)
- [OpenAI Codex Security](https://developers.openai.com/codex/security/)
- [Anthropic: Claude Code Sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing)
- [Google: AI Agents on GKE](https://codelabs.developers.google.com/codelabs/gke/ai-agents-on-gke)

## License

This analysis is provided as-is for educational purposes.
