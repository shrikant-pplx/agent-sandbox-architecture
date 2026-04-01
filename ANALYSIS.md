# Complete Design Analysis: Secure, Scalable Agent Sandbox Infrastructure

**Subject**: Architecture analysis of Browser Use's agent sandbox infrastructure, as described by [Larsen Cundric (@larsencc)](https://x.com/larsencc/status/2027225210412470668) — founding engineer at [Browser Use](https://browser-use.com/posts/two-ways-to-sandbox-agents).

**Date**: February 27, 2026

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Detailed Design Explanation](#2-detailed-design-explanation)
3. [Architecture Diagrams](#3-architecture-diagrams)
4. [Comparative Analysis with Real-World Agent Systems](#4-comparative-analysis-with-real-world-agent-systems)
5. [Security Threat Modeling](#5-security-threat-modeling)
6. [Recommended Best Architecture for Running Agents](#6-recommended-best-architecture-for-running-agents)
7. [Sources](#7-sources)

---

## 1. Architecture Overview

### Context

[Browser Use](https://browser-use.com/posts/two-ways-to-sandbox-agents) runs millions of web agents that browse the internet and complete tasks autonomously. Their infrastructure evolved through three stages:

| Stage | Architecture | Limitations |
|-------|-------------|-------------|
| **V1: AWS Lambda** | Browser-only agents; each invocation isolated | No code execution capability |
| **V2: Backend + Sandbox Tool** (Pattern 1) | Agent loop on backend; code execution in separate sandbox | Agent coupled to REST API; redeploys kill agents; resource contention |
| **V3: Isolated Agent + Control Plane** (Pattern 2) | Entire agent in Unikraft micro-VM; control plane proxies all external access | Extra network hop (negligible vs LLM latency); 3 services to manage |

### Core Philosophy

> **"Your agent should have nothing worth stealing and nothing worth preserving."**

This zero-trust, disposable-agent philosophy drives every design decision: the agent sandbox holds no secrets, no persistent state, and no credentials. Everything of value resides in the control plane.

### The Two Fundamental Patterns

The article identifies two foundational patterns for sandboxing agents that execute arbitrary code:

**Pattern 1 — Isolate the Tool**: The agent runs on your infrastructure. Only dangerous operations (code execution, terminal) run in a separate sandbox. The agent calls the sandbox via HTTP.

**Pattern 2 — Isolate the Agent**: The entire agent runs inside a sandbox with zero secrets. It communicates with the outside world exclusively through a control plane that holds all credentials.

Browser Use chose **Pattern 2** after starting with Pattern 1.

---

## 2. Detailed Design Explanation

### 2.1 The Sandbox Layer

The same container image runs in all environments. A single config switch controls the runtime:

```
sandbox_mode: 'docker' | 'ukc'
```

#### Unikraft Micro-VMs in Production

- Each agent gets its own [Unikraft](https://unikraft.io/) micro-VM, booting in **under 1 second**
- Provisioned via Unikraft Cloud's REST API on **dedicated bare metal machines** in AWS
- Only **3 environment variables** passed to the sandbox:
  - `SESSION_TOKEN` — Bearer token for control plane authentication
  - `CONTROL_PLANE_URL` — Endpoint of the proxy service
  - `SESSION_ID` — Unique identifier for the agent session
- **No AWS keys, no database credentials, no API tokens** enter the sandbox
- **Scale-to-zero**: Idle VMs suspend; resume instantly on next request
- Distributed across **multiple Unikraft metros** to prevent bottlenecks

#### Docker in Development & Evals

- Same image, same entrypoint, same control plane protocol
- Used on dev laptops and for running hundreds of parallel evaluations
- Enables dev/prod parity

### 2.2 Sandbox Hardening

Three hardening techniques execute before any agent code runs:

#### 1. Bytecode-Only Execution
During the Docker build, all Python source files are compiled to `.pyc` bytecode. Every `.py` file is then **deleted**. The framework code loads into memory as root; once loaded, the source code no longer exists on disk.

**Why it matters**: Prevents an agent from reading, modifying, or exfiltrating the framework's source code. Raises the bar for reverse engineering or code injection.

#### 2. Privilege Drop
The entrypoint starts as `root` (required to read root-owned bytecode), then immediately drops to an unprivileged `sandbox` user via `setuid`/`setgid`. From that point, everything runs unprivileged.

**Why it matters**: Limits the blast radius of any exploit. Even if the agent achieves code execution, it cannot escalate to root within the sandbox.

#### 3. Environment Stripping
After reading `SESSION_TOKEN`, `CONTROL_PLANE_URL`, and `SESSION_ID` into Python variables, they are **deleted from `os.environ`**. If the agent inspects the environment, those variables are gone.

**Why it matters**: Even the minimal credentials passed to the sandbox are only available during startup. The token is useless outside the sandbox's private VPC network anyway.

### 2.3 The Control Plane

The control plane is the sole gateway between the isolated sandbox and the outside world. It functions as a **stateless proxy service** built on FastAPI.

#### Authentication Flow

Every request from the sandbox carries a `Bearer: {session_token}` header. The control plane:
1. Looks up the session by token
2. Validates the session is still active
3. Executes the operation with **real credentials** (which the sandbox never sees)

#### LLM Proxying

- Sandbox sends only **new messages** to the control plane
- Control plane **owns the full conversation history** in its database
- Reconstructs complete context on each call and forwards to the LLM provider
- This keeps the sandbox **stateless** — kill it and spin up a new one; the conversation resumes

The control plane also enforces **cost caps** and handles **billing**.

#### File Sync via Presigned URLs

The sandbox has a `/workspace` directory for reading/writing files. File sync to S3 works without AWS credentials:

1. Sandbox detects changed files in `/workspace`
2. Sandbox calls `POST /presigned-urls` with file paths
3. Control plane generates **presigned S3 upload URLs** (scoped to the session)
4. Sandbox uploads directly to S3 using those URLs

Downloads work the same way in reverse. The sandbox gets scoped S3 access **without ever holding an AWS credential**.

#### The Gateway Protocol

```python
class AgentGateway(Protocol):
    async def invoke_llm(self, new_messages, tools, tool_choice) -> LLMResponse: ...
    async def persist_messages(self, messages) -> None: ...
```

Two implementations exist:
- `ControlPlaneGateway` — sends HTTP requests to the control plane (production)
- `DirectGateway` — calls LLM directly and keeps history in memory (development/evals)

The agent code is **unaware** of which gateway it uses. Same interface, same behavior, different backend.

### 2.4 Scaling Architecture

Each layer scales independently based on its own bottleneck:

| Layer | Technology | Scaling Mechanism |
|-------|-----------|-------------------|
| **Backend** | ECS Fargate in private subnets behind ALB | Auto-scales on CPU utilization |
| **Control Plane** | Stateless FastAPI on ECS Fargate | Auto-scales on CPU; stateless = horizontal scaling |
| **Sandboxes** | Unikraft micro-VMs on bare metal | Each session gets own VM; Unikraft schedules across metros |

### 2.5 Tradeoffs

| Advantage | Cost |
|-----------|------|
| Complete secret isolation | Extra network hop on every operation |
| Agent disposability — kill, restart, scale independently | 3 services to deploy instead of 1 |
| Stateless sandboxes — conversation survives sandbox death | Control plane becomes a critical dependency |
| Dev/prod parity with Docker/Unikraft switch | Unikraft is a less mainstream technology |

In practice, the extra network hop latency is **noise compared to LLM response times**, and the operational complexity is familiar to any ops team running microservices.

---

## 3. Architecture Diagrams

### Diagram 1: Pattern 1 — Isolate the Tool (Initial Architecture)

This was Browser Use's initial approach. The agent loop runs on the backend alongside the REST API. Only code execution is sandboxed.

```
┌─────────────────────────────┐
│         BACKEND             │
│  ┌──────────┐ ┌───────────┐│         ┌─────────────────────────┐
│  │ REST API │ │Agent Loop ─┼────────►│ External Services       │
│  └──────────┘ └─────┬─────┘│         │ (LLM, S3, Browser)      │
│                     │       │         └─────────────────────────┘
└─────────────────────┼───────┘
                      │
                      ▼
              ┌───────────────┐
              │Terminal Sandbox│
              └───────────────┘

        Security ✓  ·  Decoupled ✗  ·  Scalable ✗
```

**Problems**:
- Agent loop shares process with REST API
- Redeployments kill all running agents
- Memory-hungry agents slow down the API
- Two fundamentally different workloads (API serving vs. agent execution) coupled together

### Diagram 2: Pattern 2 — Isolate the Agent (Final Architecture)

The entire agent runs inside an isolated sandbox. All external access routes through the control plane.

```
┌─────────┐     ┌───────────────┐     ┌───────────────┐     ┌─────────────────────────┐
│ Backend │────►│ Agent Sandbox │────►│ Control Plane │────►│ External Services       │
│         │     │  (Unikraft    │     │  (Stateless   │     │ (LLM, S3, Browser)      │
│         │     │   micro-VM)   │     │   FastAPI)    │     │                         │
└─────────┘     └───────────────┘     └───────────────┘     └─────────────────────────┘

        Security ✓  ·  Decoupled ✓  ·  Scalable ✓
```

### Diagram 3: Full Production Architecture with Scaling

```
┌──────────────────┐  ┌─────────────────────────────┐  ┌──────────────────────────┐  ┌─────────────────────┐
│     BACKEND      │  │     UNIKRAFT BARE METAL      │  │      CONTROL PLANE       │  │  EXTERNAL SERVICES  │
│  (ECS Fargate)   │  │                               │  │    (ECS Fargate + ALB)   │  │                     │
│                  │  │  ┌─────────────────────────┐  │  │                          │  │  ┌───────────────┐  │
│  ┌────────────┐  │  │  │  Agent Sandbox 1 (VM)   │  │  │  ┌──────────────────┐   │  │  │   Storage     │  │
│  │ Instance 1 ├──┼──┼─►│                         ├──┼──┼─►│   Instance 1     │───┼──┼─►│   (S3)        │  │
│  └────────────┘  │  │  └─────────────────────────┘  │  │  └──────────────────┘   │  │  └───────────────┘  │
│                  │  │  ┌─────────────────────────┐  │  │                          │  │                     │
│  ┌────────────┐  │  │  │  Agent Sandbox 2 (VM)   │  │  │  ┌──────────────────┐   │  │  ┌───────────────┐  │
│  │ Instance 2 ├──┼──┼─►│                         ├──┼──┼─►│   Instance 2     │───┼──┼─►│  LLM Provider │  │
│  └────────────┘  │  │  └─────────────────────────┘  │  │  └──────────────────┘   │  │  └───────────────┘  │
│                  │  │  ┌─────────────────────────┐  │  │                          │  │                     │
│                  │  │  │  Agent Sandbox 3 (VM)   │  │  │  ┌──────────────────┐   │  │  ┌───────────────┐  │
│                  │  │  │                         ├──┼──┼─►│   Instance 3     │───┼──┼─►│   Browser     │  │
│                  │  │  └─────────────────────────┘  │  │  └──────────────────┘   │  │  └───────────────┘  │
│                  │  │  ┌─────────────────────────┐  │  │                          │  │                     │
│                  │  │  │  Agent Sandbox 4 (VM)   │  │  │                          │  │                     │
│                  │  │  │         ...              │  │  │                          │  │                     │
│                  │  │  └─────────────────────────┘  │  │                          │  │                     │
│                  │  │  ┌─────────────────────────┐  │  │                          │  │                     │
│                  │  │  │  Agent Sandbox N (VM)   │  │  │                          │  │                     │
│                  │  │  └─────────────────────────┘  │  │                          │  │                     │
└──────────────────┘  └─────────────────────────────┘  └──────────────────────────┘  └─────────────────────┘

  Auto-scales on CPU      Each session = own VM         Stateless; horizontal        Managed external
  via ECS Fargate         Unikraft schedules across     scaling behind ALB           services
                          multiple metros
```

### Diagram 4: Data Flow — LLM Proxying

```
┌─────────────────┐            ┌─────────────────────┐            ┌─────────────────┐
│  Agent Sandbox   │            │    Control Plane     │            │  LLM Provider   │
│  (Unikraft VM)   │            │    (FastAPI)         │            │  (e.g. OpenAI)  │
│                  │            │                     │            │                 │
│  Agent generates │  HTTP POST │  1. Validate token  │            │                 │
│  new messages   ─┼───────────►│  2. Look up session │            │                 │
│                  │  Bearer:   │  3. Reconstruct     │  API call  │                 │
│                  │  {token}   │     full history     ├───────────►│  Process full   │
│                  │            │     from DB          │            │  conversation   │
│                  │            │  4. Forward to LLM   │            │                 │
│  Receive LLM    │◄───────────┤  5. Return response  │◄───────────┤  Return         │
│  response       │            │  6. Enforce cost caps │            │  completion     │
│                  │            │  7. Log billing      │            │                 │
└─────────────────┘            └─────────────────────┘            └─────────────────┘
```

### Diagram 5: Data Flow — File Sync via Presigned URLs

```
┌─────────────────┐            ┌─────────────────────┐            ┌─────────────────┐
│  Agent Sandbox   │            │    Control Plane     │            │    Amazon S3    │
│                  │            │                     │            │                 │
│  1. Detect file │  POST      │                     │            │                 │
│     changes in  ─┼───────────►│  2. Generate        │            │                 │
│     /workspace  │ /presigned │     presigned URLs   │            │                 │
│                  │  -urls     │     scoped to        │            │                 │
│  3. Upload      │            │     session          │            │                 │
│     directly   ─┼────────────┼─────────────────────┼───────────►│  4. Store files │
│     via presign │            │                     │            │                 │
│     URL         │            │  (No AWS creds in   │            │                 │
│                  │            │   sandbox ever)     │            │                 │
└─────────────────┘            └─────────────────────┘            └─────────────────┘
```

### Diagram 6: Sandbox Hardening Sequence

```
┌──────────────────────────────────────────────────────────────┐
│                    SANDBOX BOOT SEQUENCE                     │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐     │
│  │ STEP 1: Bytecode-Only Execution                     │     │
│  │  • Docker build: compile .py → .pyc                 │     │
│  │  • Delete all .py source files                      │     │
│  │  • Load framework as root from .pyc                 │     │
│  └──────────────────────┬──────────────────────────────┘     │
│                         ▼                                    │
│  ┌─────────────────────────────────────────────────────┐     │
│  │ STEP 2: Privilege Drop                              │     │
│  │  • Start as root (needed for bytecode read)         │     │
│  │  • setuid/setgid → drop to 'sandbox' user           │     │
│  │  • All subsequent execution is unprivileged         │     │
│  └──────────────────────┬──────────────────────────────┘     │
│                         ▼                                    │
│  ┌─────────────────────────────────────────────────────┐     │
│  │ STEP 3: Environment Stripping                       │     │
│  │  • Read SESSION_TOKEN, CONTROL_PLANE_URL,           │     │
│  │    SESSION_ID into Python variables                 │     │
│  │  • Delete from os.environ                           │     │
│  │  • Token useless outside private VPC anyway         │     │
│  └──────────────────────┬──────────────────────────────┘     │
│                         ▼                                    │
│  ┌─────────────────────────────────────────────────────┐     │
│  │ AGENT CODE RUNS (unprivileged, no env vars,         │     │
│  │ no source code, private VPC, only control plane     │     │
│  │ access)                                             │     │
│  └─────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Comparative Analysis with Real-World Agent Systems

### 4.1 Industry Landscape

The following table compares Browser Use's architecture against other major production agent systems:

| Dimension | Browser Use | Manus AI | OpenAI Codex | Anthropic Claude Code | Google GKE Agent Sandbox | Devin (Cognition) |
|-----------|------------|----------|-------------|----------------------|--------------------------|-------------------|
| **Isolation Technology** | Unikraft micro-VMs | [E2B (Firecracker micro-VMs)](https://e2b.dev/blog/how-manus-uses-e2b-to-provide-agents-with-virtual-computers) | [OS-level sandbox (Landlock + seccomp, macOS Seatbelt)](https://developers.openai.com/codex/security/) | [Bubblewrap (Linux), Seatbelt (macOS)](https://www.anthropic.com/engineering/claude-code-sandboxing) | [gVisor (user-space kernel)](https://codelabs.developers.google.com/codelabs/gke/ai-agents-on-gke) | [Docker/VM cloud sandbox](https://www.datacamp.com/tutorial/devin-ai) |
| **Isolation Level** | Hardware (dedicated kernel per VM) | Hardware (Firecracker, dedicated kernel) | OS-level (syscall filtering) | OS-level (namespace/seccomp) | Syscall-level (user-space kernel) | VM-level (cloud instance) |
| **Sandbox Pattern** | Pattern 2: Isolate the agent | Pattern 2: Full VM per task | Hybrid: OS sandbox + approval gates | Hybrid: OS sandbox + network proxy | Pattern 1: Isolate the tool (GKE pod) | Pattern 2: Full VM per task |
| **Credential Management** | Control plane holds all credentials; sandbox gets only session token | Sandbox has no direct credential access; managed by Manus platform | Secrets available during setup phase only; removed before agent phase | Credentials never inside sandbox; custom git proxy handles auth | Agent pod uses Kubernetes RBAC and service accounts | Sandboxed workspace; credentials managed externally |
| **Network Isolation** | Private VPC; only control plane access | Full internet access within VM; [zero-trust per sandbox](https://manus.im/blog/manus-sandbox) | [Network off by default](https://developers.openai.com/codex/security/); domain allowlists configurable | [Network isolation via proxy; domain allowlists](https://www.anthropic.com/engineering/claude-code-sandboxing) | [Kubernetes Network Policies; egress denied by default](https://codelabs.developers.google.com/codelabs/gke/ai-agents-on-gke) | Network-capable within sandbox |
| **State Management** | Stateless sandbox; control plane owns conversation history in DB | Persistent sandbox with sleep/wake lifecycle | Stateful workspace per project/branch | Stateful working directory | Ephemeral pods; warm pool for fast startup | Persistent workspace with replay timeline |
| **Scaling Model** | Independent: Backend (ECS), Control Plane (ECS), Sandboxes (Unikraft) | [E2B handles scaling; ~150ms spin-up](https://e2b.dev/blog/how-manus-uses-e2b-to-provide-agents-with-virtual-computers) | Per-agent cloud containers (OpenAI managed) | Per-session cloud sandbox | [Kubernetes horizontal pod autoscaling + warm pools](https://codelabs.developers.google.com/codelabs/gke/ai-agents-on-gke) | Cloud VM per agent; parallel agents for paid tiers |
| **Boot Time** | < 1 second (Unikraft) | ~150ms (E2B/Firecracker) | Milliseconds (OS sandbox) | Milliseconds (Bubblewrap) | Sub-second with warm pools (gVisor) | Seconds (full VM) |
| **Key Advantage** | Full agent isolation with stateless recovery | Full OS; agent can install packages, run services | Deep OS integration; configurable trust levels | Open-source sandbox; 84% fewer permission prompts | Kubernetes-native; enterprise-grade | Full dev environment (editor, browser, terminal) |

### 4.2 Pattern Comparison: Isolate the Tool vs. Isolate the Agent

| Aspect | Pattern 1: Isolate the Tool | Pattern 2: Isolate the Agent |
|--------|----------------------------|------------------------------|
| **Who uses it** | Google GKE Agent Sandbox, early Browser Use | Browser Use (current), Manus, Devin, E2B customers |
| **Agent runs where** | On your infrastructure (backend) | Inside isolated sandbox |
| **What's sandboxed** | Only dangerous operations (code exec, shell) | The entire agent + all its operations |
| **Secrets exposure** | Agent has access to infra secrets | Agent has zero secrets |
| **Failure blast radius** | Agent failure can affect backend | Agent failure is fully contained |
| **Scalability** | Agent scaling coupled to backend | Each layer scales independently |
| **Complexity** | Simpler; fewer services | More complex; requires control plane proxy |
| **State recovery** | Agent death loses conversation state | Conversation state in control plane; sandbox is disposable |
| **Best for** | Low-risk tool augmentation; trusted agents | Production multi-tenant platforms; untrusted code execution |

### 4.3 Isolation Technology Comparison

| Technology | Isolation Boundary | Boot Time | Overhead | Security Level | Used By |
|-----------|-------------------|-----------|----------|---------------|---------|
| **Standard Docker** | Linux namespaces + cgroups (shared kernel) | Milliseconds | Minimal | Low — [kernel vulnerabilities enable container escape](https://northflank.com/blog/how-to-sandbox-ai-agents) | Dev/test only |
| **gVisor** | [User-space kernel intercepting syscalls](https://northflank.com/blog/firecracker-vs-gvisor) | Milliseconds | 10-30% on I/O | Medium — reduced kernel attack surface | Google GKE, Modal |
| **Firecracker** | [Hardware virtualization (KVM); dedicated kernel per VM](https://northflank.com/blog/firecracker-vs-gvisor) | ~125ms | ~5 MiB per VM | High — hardware-enforced boundary | AWS Lambda, E2B, Manus |
| **Unikraft** | [Unikernel micro-VM; minimal OS per VM](https://www.heavybit.com/library/podcasts/open-source-ready/ep-30-inside-unikraft-and-unikernels-with-felipe-huici) | < 1 second | Very low | High — minimal attack surface + VM boundary | Browser Use, Kernel |
| **Kata Containers** | [Full VM with Kubernetes-native orchestration](https://northflank.com/blog/how-to-sandbox-ai-agents) | ~200ms | Low-moderate | High — dedicated kernel per pod | Northflank, enterprise K8s |
| **OS Sandbox (Landlock/Seatbelt)** | [Syscall filtering + filesystem/network restrictions](https://developers.openai.com/codex/security/) | Negligible | Negligible | Medium — depends on policy completeness | OpenAI Codex, Claude Code |

### 4.4 Emerging Architectural Patterns in the Industry

Beyond the specific systems above, several [design patterns are emerging for 2026](https://www.linkedin.com/posts/rakeshgohel01_these-new-design-patterns-will-lead-ai-agents-activity-7404507762258280448-P-pc):

1. **Control Plane as a Tool** ([arxiv paper](https://arxiv.org/html/2505.06817v1)): Expose a single tool interface to agents while encapsulating modular routing logic behind it. Browser Use's control plane is an excellent implementation of this pattern.

2. **Sidecar Proxy Pattern**: Similar to service meshes (Envoy/Istio), a sidecar proxy mediates all agent communication. [Used in production fleet architectures](https://dev.to/nesquikm/i-run-a-fleet-of-ai-agents-in-production-heres-the-architecture-that-keeps-them-honest-3l1h) where the proxy injects auth, enforces rate limits, and prevents credential exposure.

3. **Multi-Agent Interoperability**: Google's A2A Protocol and Anthropic's MCP enabling agents from different systems to communicate via standardized protocols.

4. **CodeAct Agents**: Agents use chain-of-thought and self-reflection within sandboxes, dynamically creating/revising actions (used by Manus).

5. **Magentic Orchestration**: Task ledger with human oversight for complex agentic retrieval tasks (used by [Microsoft Copilot, Perplexity](https://www.linkedin.com/posts/rakeshgohel01_these-new-design-patterns-will-lead-ai-agents-activity-7404507762258280448-P-pc)).

6. **Three-Tier Enterprise Framework** ([InfoQ](https://www.infoq.com/news/2025/10/ai-agent-orchestration/)): Foundation (tool orchestration + transparency) → Workflow (prompt chaining, routing, parallelization) → Autonomous (agents determine own approaches).

---

## 5. Security Threat Modeling

### 5.1 STRIDE Threat Analysis of Browser Use Architecture

#### Spoofing

| Threat | Risk Level | Description | Existing Mitigation | Residual Risk |
|--------|-----------|-------------|---------------------|---------------|
| **Session Token Theft** | Medium | An agent could attempt to extract the session token from memory to impersonate a legitimate session | Environment stripping removes token from `os.environ`; token is useless outside private VPC | Token still exists in Python process memory; a sophisticated memory dump could extract it |
| **Control Plane Impersonation** | Low | Attacker spoofs a control plane endpoint to intercept agent communications | Sandbox connects only to `CONTROL_PLANE_URL` within private VPC | If VPC routing is compromised, MITM is possible; mTLS would mitigate |
| **Sandbox Identity Spoofing** | Low | A malicious sandbox impersonates another session | Bearer token authentication per session | Token scope and validation prevent cross-session access |

#### Tampering

| Threat | Risk Level | Description | Existing Mitigation | Residual Risk |
|--------|-----------|-------------|---------------------|---------------|
| **Bytecode Tampering** | Low | Agent modifies `.pyc` files at runtime to alter framework behavior | Privilege drop to `sandbox` user; bytecode owned by root | If a privilege escalation vulnerability exists in the kernel or Unikraft, root access is possible |
| **Control Plane Request Manipulation** | Medium | Agent crafts malicious requests to the control plane to trigger unintended behavior | Control plane validates session tokens and enforces cost caps | Insufficient input validation on control plane endpoints could allow injection attacks |
| **Conversation History Poisoning** | Medium | Agent sends crafted messages that, when reconstructed by control plane, produce prompt injection against the LLM | Control plane reconstructs history from DB | If new messages aren't sanitized, poisoned history could manipulate LLM behavior |
| **File System Tampering** | Low | Agent modifies files in `/workspace` to inject malicious content that gets synced to S3 | Presigned URLs are scoped to session | Downstream consumers of synced files could be affected if they trust sandbox output |

#### Repudiation

| Threat | Risk Level | Description | Existing Mitigation | Residual Risk |
|--------|-----------|-------------|---------------------|---------------|
| **Unattributable Agent Actions** | Medium | Actions taken by the agent cannot be traced back to the specific session or user | Session-based token tracking; control plane logs | Article doesn't mention structured audit logging with correlation IDs; production should implement this |
| **LLM Call Attribution** | Low | Cannot determine which agent made which LLM call | Session token in every request | If logging is insufficient, cost attribution and forensics become difficult |

#### Information Disclosure

| Threat | Risk Level | Description | Existing Mitigation | Residual Risk |
|--------|-----------|-------------|---------------------|---------------|
| **Memory Inspection** | Medium | Agent reads process memory to extract session token or framework internals | Environment stripping; bytecode-only execution | Sophisticated agents could use `/proc/self/mem` or Python `ctypes` to inspect process memory |
| **Side-Channel Attacks** | Low | Agent infers information about co-located VMs through timing, cache, or resource usage | Each agent gets its own Unikraft micro-VM (hardware isolation) | Micro-VMs on same bare metal could theoretically share cache; risk is minimal with Unikraft's minimal attack surface |
| **Presigned URL Leakage** | Medium | Agent exfiltrates presigned S3 URLs that could be used to access files | URLs are session-scoped and time-limited; sandbox has no outbound network except control plane | If URLs have long expiry or if the control plane doesn't restrict URL generation rate, bulk extraction is possible |
| **LLM Context Leakage** | Low | Conversation history in the control plane DB could be accessed if DB is compromised | Standard database security | Not specific to this architecture; standard DB security practices apply |

#### Denial of Service

| Threat | Risk Level | Description | Existing Mitigation | Residual Risk |
|--------|-----------|-------------|---------------------|---------------|
| **Resource Exhaustion in Sandbox** | Medium | Agent consumes all CPU/memory within its VM, affecting performance | Each agent has its own VM (resource isolation) | Unikraft resource limits are not explicitly mentioned; should be enforced |
| **Control Plane Overload** | High | Malicious or buggy agents flood the control plane with requests | Auto-scaling on CPU; ALB | Rate limiting per session is not mentioned; a single agent could generate excessive requests |
| **LLM Cost Bombing** | Medium | Agent triggers excessive LLM calls to inflate costs | Cost caps enforced by control plane | Cost cap granularity and enforcement speed are critical; delayed enforcement could allow cost spikes |
| **Presigned URL Abuse** | Low | Agent requests excessive presigned URLs to overwhelm S3 | Session scoping | Rate limiting on presigned URL generation is not explicitly mentioned |
| **Fork Bomb / Process Exhaustion** | Medium | Agent spawns excessive processes within the sandbox | Privilege drop limits capabilities | Without explicit PID/process limits (cgroups), a fork bomb could exhaust VM resources |

#### Elevation of Privilege

| Threat | Risk Level | Description | Existing Mitigation | Residual Risk |
|--------|-----------|-------------|---------------------|---------------|
| **Sandbox Escape** | Low | Agent exploits vulnerability to escape the micro-VM | Unikraft hardware-level VM isolation (KVM-backed) | Unikraft is newer/less battle-tested than Firecracker; potential for undiscovered escape vectors |
| **Privilege Escalation within Sandbox** | Low | Agent escalates from `sandbox` user to `root` | `setuid`/`setgid` privilege drop | Kernel vulnerabilities within the guest OS could enable escalation; Unikraft's minimal kernel reduces attack surface |
| **Control Plane Exploitation** | High | Attacker compromises control plane to gain access to all credentials | Control plane runs in private subnets; standard security practices | Control plane is a **high-value target** — it holds all API keys, DB credentials, and LLM tokens. Compromise = total access |
| **Cross-Session Access** | Low | Agent accesses another session's data or resources | Session token validation; session-scoped presigned URLs | Logic bugs in session validation could enable cross-tenant access |

### 5.2 Attack Surface Diagram

```
                                    ATTACK SURFACE MAP
                                    ==================

┌──────────────────────────────────────────────────────────────────────────────┐
│                            EXTERNAL ATTACKERS                                │
│                                                                              │
│   ┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐  │
│   │ Prompt Injection │     │ Malicious Agent  │     │ Supply Chain Attack │  │
│   │ via User Input   │     │ Code Execution   │     │ on Dependencies    │  │
│   └────────┬────────┘     └────────┬─────────┘     └──────────┬──────────┘  │
│            │                       │                           │              │
└────────────┼───────────────────────┼───────────────────────────┼──────────────┘
             │                       │                           │
             ▼                       ▼                           ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                        AGENT SANDBOX (Unikraft VM)                         │
│                                                                            │
│   Attack Vectors:                                                          │
│   [A1] Memory inspection (/proc/self/mem, ctypes)                          │
│   [A2] Process spawning (fork bomb, reverse shells)                        │
│   [A3] Bytecode manipulation (if escalation achieved)                      │
│   [A4] Network probing within private VPC                                  │
│   [A5] Timing/resource side-channels                                       │
│                                                                            │
│   Mitigations: Privilege drop, env stripping, bytecode-only,               │
│                private VPC, hardware VM isolation                           │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │  (Session Token via Bearer header)
                                   ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                     CONTROL PLANE (FastAPI)  ★ HIGH VALUE TARGET ★          │
│                                                                            │
│   Attack Vectors:                                                          │
│   [B1] Session token replay/brute-force                                    │
│   [B2] Input injection in LLM proxy requests                               │
│   [B3] Presigned URL generation abuse                                      │
│   [B4] Rate limiting bypass / DoS                                          │
│   [B5] Logic bugs in session validation                                    │
│   [B6] Compromise = access to ALL credentials                              │
│                                                                            │
│   Mitigations: Token validation, session scoping, cost caps,               │
│                private subnets, ALB                                         │
│                                                                            │
│   MISSING: Rate limiting per session, mTLS, structured audit logs,         │
│            input validation/sanitization, WAF                               │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │  (Real credentials)
                                   ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                        EXTERNAL SERVICES                                   │
│   Storage (S3)  ·  LLM Provider  ·  Browser                               │
│                                                                            │
│   Attack Vectors:                                                          │
│   [C1] Credential theft from control plane                                 │
│   [C2] Excessive LLM token consumption                                     │
│   [C3] S3 data exfiltration via presigned URL abuse                        │
└────────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Top 10 Security Risks (Prioritized)

| # | Risk | Severity | Likelihood | Impact | Recommended Mitigation |
|---|------|----------|------------|--------|----------------------|
| 1 | **Control plane compromise** — single point holding all credentials | Critical | Low | Total system compromise | Defense-in-depth: WAF, mTLS between services, secrets rotation, HSM for key storage, separate credential vaults per service |
| 2 | **Insufficient rate limiting on control plane** — agents can flood requests | High | Medium | Service degradation, cost explosion | Per-session rate limiting, token bucket algorithms, circuit breakers |
| 3 | **Prompt injection via conversation history** — poisoned messages manipulate LLM | High | Medium | Unauthorized actions, data exfiltration via LLM output | Input sanitization on control plane, LLM output filtering, separate user-facing and data-facing model instances ([NCC Group gatekeeper pattern](https://www.nccgroup.com/research-blog/analyzing-secure-ai-architectures/)) |
| 4 | **Session token extraction from memory** — sophisticated agent reads process memory | Medium | Low | Session hijacking (limited to private VPC) | Encrypt tokens in memory, use hardware-backed token storage where possible, minimize token lifetime |
| 5 | **Presigned URL abuse** — bulk generation and potential data exfiltration | Medium | Medium | Unauthorized file access | Rate limit URL generation, short expiry times (5 min), monitor generation patterns |
| 6 | **Unikraft escape vulnerability** — less battle-tested than Firecracker | Medium | Very Low | VM escape; access to bare metal host | Regular security audits of Unikraft, consider nested isolation, contribute to upstream security |
| 7 | **Missing audit trail** — actions not fully traceable | Medium | Medium | Compliance failures, difficult incident response | Implement structured logging with correlation IDs across all services, SIEM integration |
| 8 | **Cross-session data leakage** — logic bugs in session validation | Medium | Low | Unauthorized access to other users' data | Extensive fuzzing of session validation logic, session isolation tests, formal verification where possible |
| 9 | **Supply chain attack on sandbox image** — compromised dependencies | Medium | Low | Backdoored agent environment | Image signing, SBOM generation, vulnerability scanning in CI/CD, minimal base images |
| 10 | **Cost bombing via LLM** — malicious agents trigger excessive LLM calls before cost cap kicks in | Medium | Medium | Financial impact | Real-time token counting with hard cutoffs, pre-call budget checks, anomaly detection on usage patterns |

### 5.4 Comparison of Security Posture

| Security Dimension | Browser Use | Best-in-Class | Gap |
|-------------------|------------|---------------|-----|
| **Isolation** | Unikraft micro-VM (hardware-level) | Firecracker micro-VM | Minimal — both are hardware-level; Firecracker has more battle-testing at AWS scale |
| **Credential Isolation** | Zero secrets in sandbox; control plane proxy | Zero secrets + credential injection middleware | Browser Use matches best practice |
| **Network Isolation** | Private VPC; control-plane-only egress | Network policies + egress deny-all + proxy allowlists | Strong; could add explicit egress deny rules |
| **State Management** | Stateless sandbox; control plane owns state | Stateless + encrypted state store | Good; could add encryption at rest for conversation history |
| **Audit/Observability** | Not explicitly described | Structured logs + correlation IDs + SIEM + behavioral analytics | **Significant gap** — needs structured observability |
| **Input Validation** | Cost caps mentioned; no explicit input sanitization | Input validation + output filtering + intent-based authorization | **Gap** — control plane should validate/sanitize all agent inputs |
| **mTLS** | Not mentioned | mTLS between all internal services | **Gap** — should implement mTLS between sandbox and control plane |
| **Secret Rotation** | Not mentioned | Automated secret rotation with short-lived credentials | **Gap** — control plane credentials should rotate automatically |

---

## 6. Recommended Best Architecture for Running Agents

### 6.1 The Ideal Architecture: Defense-in-Depth Agent Platform

Based on analysis of Browser Use's architecture, industry comparisons, and threat modeling, the following represents the recommended best architecture for running agents at scale.

### 6.2 Architectural Principles

1. **Zero Trust Everywhere**: Never trust the agent. Never trust internal services by default. Verify explicitly on every request.
2. **Dispose, Don't Preserve**: Agents should be stateless and disposable. All valuable state lives outside the sandbox.
3. **Proxy Everything**: All external access must be mediated by an authenticated, rate-limited proxy layer.
4. **Hardware Isolation for Untrusted Code**: Use micro-VMs (Firecracker or Unikraft) — not containers — for executing untrusted agent code.
5. **Independent Scaling**: Each layer (backend, sandboxes, control plane, external services) must scale independently.
6. **Observable by Default**: Every action, every request, every decision must be logged with correlation IDs.

### 6.3 Recommended Architecture

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              RECOMMENDED ARCHITECTURE                                  │
│                                                                                        │
│  ┌──────────┐    ┌─────────────────────────────────┐    ┌─────────────────────────┐    │
│  │          │    │       SANDBOX FLEET              │    │                         │    │
│  │ BACKEND  │    │  ┌───────────────────────────┐  │    │    CONTROL PLANE        │    │
│  │          │    │  │  Agent Sandbox (micro-VM)  │  │    │                         │    │
│  │ ┌──────┐ │    │  │  • Firecracker/Unikraft   │  │    │  ┌───────────────────┐  │    │
│  │ │API   │─┼───►│  │  • Bytecode-only          │  │    │  │ Auth Gateway      │  │    │
│  │ │Server│ │    │  │  • Privilege drop          │──┼───►│  │ • mTLS            │  │    │
│  │ └──────┘ │    │  │  • Env stripping           │  │    │  │ • Rate limiting   │  │    │
│  │ ┌──────┐ │    │  │  • No outbound network     │  │    │  │ • Input validation│  │    │
│  │ │Task  │─┼───►│  │  • Read-only filesystem    │  │    │  └────────┬──────────┘  │    │
│  │ │Queue │ │    │  │    (except /workspace)      │  │    │           │             │    │
│  │ └──────┘ │    │  └───────────────────────────┘  │    │  ┌────────▼──────────┐  │    │
│  └──────────┘    │  ┌───────────────────────────┐  │    │  │ Service Router    │  │    │
│                  │  │  Agent Sandbox N           │  │    │  │ • LLM proxy       │  │    │
│                  │  │  (identical config)        │──┼───►│  │ • Storage proxy   │  │    │
│                  │  └───────────────────────────┘  │    │  │ • Tool router     │  │    │
│                  └─────────────────────────────────┘    │  │ • Cost enforcement │  │    │
│                                                         │  └────────┬──────────┘  │    │
│                                                         │           │             │    │
│                                                         │  ┌────────▼──────────┐  │    │
│                                                         │  │ Observability     │  │    │
│                                                         │  │ • Structured logs │  │    │
│                                                         │  │ • Correlation IDs │  │    │
│                                                         │  │ • Behavioral      │  │    │
│                                                         │  │   analytics       │  │    │
│                                                         │  │ • SIEM export     │  │    │
│                                                         │  └─────────────────┘  │    │
│                                                         └─────────────────────────┘    │
│                                                                    │                   │
│                                                                    ▼                   │
│                                                     ┌──────────────────────────┐       │
│                                                     │   EXTERNAL SERVICES      │       │
│                                                     │  • LLM Providers         │       │
│                                                     │  • Storage (S3)          │       │
│                                                     │  • Browser Infrastructure│       │
│                                                     │  • Third-party APIs      │       │
│                                                     └──────────────────────────┘       │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.4 Layer-by-Layer Recommendations

#### Sandbox Layer

| Component | Recommendation | Rationale |
|-----------|---------------|-----------|
| **Isolation** | Firecracker micro-VMs (primary) or Unikraft (alternative) | [Firecracker is the gold standard](https://northflank.com/blog/how-to-sandbox-ai-agents) — battle-tested at AWS Lambda scale, ~125ms boot, ~5MiB overhead, hardware-enforced isolation. Unikraft is a valid alternative with smaller attack surface due to unikernel design. |
| **Boot optimization** | Warm pools + snapshot/restore | Pre-boot VMs and snapshot them. On request, restore from snapshot for sub-100ms startup. [Used by Kernel](https://www.youtube.com/watch?v=3VgRy609EmU) and [Google GKE Agent Sandbox](https://codelabs.developers.google.com/codelabs/gke/ai-agents-on-gke). |
| **Filesystem** | Read-only root; writable `/workspace` only | Agent cannot modify the system. Only workspace directory is writable and synced. |
| **Hardening** | Bytecode-only + privilege drop + env stripping + seccomp profile | Browser Use's hardening is excellent. Add a seccomp profile to restrict syscalls, and consider read-only `/proc` to prevent memory inspection. |
| **Resource limits** | CPU quota, memory limit, PID limit, disk quota | Prevent fork bombs, memory exhaustion, and disk filling. Enforce via cgroups within the VM. |
| **Lifetime** | Session-scoped with hard timeout | Kill sandboxes after configurable max lifetime. Scale-to-zero for idle sandboxes. |

#### Control Plane Layer

| Component | Recommendation | Rationale |
|-----------|---------------|-----------|
| **Authentication** | mTLS between sandbox and control plane; session tokens for authorization | mTLS prevents MITM and ensures only legitimate sandboxes connect. Session tokens scope access. |
| **Rate limiting** | Per-session token bucket with burst limits | Prevents any single agent from overwhelming the control plane or generating excessive costs. |
| **Input validation** | Validate and sanitize all inputs from sandbox | The sandbox is untrusted. Every field in every request must be validated before processing. |
| **Output filtering** | Filter LLM responses for sensitive data leakage | Prevent credentials, PII, or internal details from appearing in LLM responses sent back to the sandbox. |
| **Credential management** | HashiCorp Vault or AWS Secrets Manager with automatic rotation | Never hardcode credentials. Use short-lived, automatically rotated secrets. The control plane should fetch credentials on-demand from a vault. |
| **State ownership** | Control plane owns all persistent state (conversation history, file metadata, billing) | Sandbox is disposable. Control plane is the source of truth. |
| **Scaling** | Stateless; horizontal scaling behind ALB with auto-scaling | Identical to Browser Use's approach. Add health checks and circuit breakers. |

#### Observability Layer

| Component | Recommendation | Rationale |
|-----------|---------------|-----------|
| **Structured logging** | JSON-structured logs with correlation IDs on every request | Enables tracing a request from user → backend → sandbox → control plane → external service. Critical for incident response. |
| **Behavioral analytics** | Baseline agent behavior; alert on anomalies | Detect unusual patterns: sudden spike in LLM calls, unexpected file access patterns, abnormal request sizes. |
| **SIEM integration** | Export to Splunk/Datadog/CloudWatch | Centralize security events for correlation with broader infrastructure monitoring. |
| **Cost monitoring** | Real-time per-session cost tracking with hard cutoffs | Prevent cost overruns. Alert before reaching budget limits. Hard-kill sessions exceeding caps. |
| **Audit trail** | Immutable audit log of all agent actions with timestamps | Required for compliance (SOC 2, ISO 27001) and forensic investigation. |

#### Network Layer

| Component | Recommendation | Rationale |
|-----------|---------------|-----------|
| **Sandbox egress** | Deny all except control plane endpoint | Sandbox should have zero outbound internet access. All external access mediated by control plane. |
| **Control plane egress** | Allowlist of external service endpoints only | Control plane should only connect to known, approved external services. |
| **WAF** | Web Application Firewall in front of control plane | Protect against injection attacks, malformed requests, and known attack patterns. |
| **VPC design** | Separate VPCs or subnets for each tier | Backend, sandboxes, and control plane in separate network segments with strict security groups. |

### 6.5 Technology Decision Matrix

| Decision | If You Need... | Choose... | Why |
|----------|---------------|-----------|-----|
| **Isolation** | Strongest possible isolation for untrusted code | Firecracker | [Hardware-level, battle-tested at AWS scale, ~125ms boot](https://northflank.com/blog/firecracker-vs-gvisor) |
| **Isolation** | Minimal attack surface + strong isolation | Unikraft | Unikernel = even smaller attack surface than Firecracker; less ecosystem maturity |
| **Isolation** | Enhanced containers without full VMs | gVisor | [Easier K8s integration, good for compute-heavy workloads](https://northflank.com/blog/firecracker-vs-gvisor), weaker than hardware isolation |
| **Orchestration** | Kubernetes-native workflow | Kata Containers + GKE Agent Sandbox | [VM-level isolation with standard K8s APIs](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox) |
| **Pattern** | Multi-tenant platform, untrusted code | Pattern 2: Isolate the Agent | Agent holds nothing of value; maximum blast radius containment |
| **Pattern** | Trusted internal agents, simple setup | Pattern 1: Isolate the Tool | Simpler architecture; acceptable when agents are controlled |
| **Control plane** | Framework-agnostic, multi-agent | Control Plane as a Tool pattern | [Modular, observable, governable](https://arxiv.org/html/2505.06817v1) |
| **Managed platform** | Avoid building infra, fast time-to-market | E2B, Northflank, or Modal | [E2B uses Firecracker](https://e2b.dev/blog/how-manus-uses-e2b-to-provide-agents-with-virtual-computers); [Northflank uses Kata + gVisor](https://northflank.com/blog/how-to-sandbox-ai-agents); Modal uses gVisor |

### 6.6 Implementation Priorities

If starting from scratch, implement in this order:

```
Phase 1: Foundation (Weeks 1-4)
├── Firecracker/Unikraft micro-VM provisioning
├── Basic control plane (FastAPI) with session token auth
├── Private VPC with egress deny
├── LLM proxying through control plane
└── Docker-based dev parity

Phase 2: Hardening (Weeks 5-8)
├── Bytecode-only execution + privilege drop + env stripping
├── mTLS between sandbox and control plane
├── Per-session rate limiting
├── Input validation on all control plane endpoints
├── Presigned URL file sync with short expiry
└── Resource limits (CPU, memory, PID, disk)

Phase 3: Observability (Weeks 9-12)
├── Structured logging with correlation IDs
├── Behavioral analytics baselines
├── SIEM integration
├── Real-time cost monitoring with hard cutoffs
├── Immutable audit trail
└── Alerting for anomalous agent behavior

Phase 4: Advanced Security (Weeks 13-16)
├── Secret rotation via Vault/Secrets Manager
├── WAF deployment
├── seccomp profiles for sandbox
├── Supply chain security (image signing, SBOM)
├── Formal session validation testing
└── Red team exercises / penetration testing
```

### 6.7 Key Takeaways

1. **Browser Use's architecture is production-grade and well-designed.** The "Isolate the Agent" pattern with a stateless control plane proxy is the correct approach for multi-tenant agent platforms running untrusted code. This is [consistent with how Manus](https://manus.im/blog/manus-sandbox), [E2B](https://e2b.dev/blog/how-manus-uses-e2b-to-provide-agents-with-virtual-computers), and [other production systems](https://dev.to/nesquikm/i-run-a-fleet-of-ai-agents-in-production-heres-the-architecture-that-keeps-them-honest-3l1h) are building.

2. **The control plane is the highest-value target.** It holds all credentials and mediates all access. Hardening it with mTLS, WAF, rate limiting, input validation, and secrets rotation is the single most impactful security investment.

3. **Observability is the biggest gap.** The article doesn't discuss structured logging, correlation IDs, or behavioral analytics. For a system running millions of agents, this is critical for incident response, compliance, and cost management.

4. **Micro-VMs are the industry consensus for untrusted code.** Whether Firecracker (AWS Lambda, E2B, Manus), Unikraft (Browser Use, Kernel), or Kata Containers (Northflank, enterprise K8s) — the industry has converged on hardware-level isolation. [Standard containers are insufficient](https://northflank.com/blog/how-to-sandbox-ai-agents).

5. **The "Isolate the Agent" pattern is winning.** Browser Use, Manus, Devin, and others all run the entire agent inside an isolated sandbox rather than just sandboxing tools. This provides maximum blast radius containment, enables stateless recovery, and decouples agent lifecycle from backend infrastructure.

---

## 7. Sources

- [Browser Use: How We Built Secure, Scalable Agent Sandbox Infrastructure](https://browser-use.com/posts/two-ways-to-sandbox-agents) — Larsen Cundric, Feb 2026
- [Larsen Cundric (@larsencc) X Article](https://x.com/larsencc/status/2027225210412470668) — Original post
- [Aembit: The 4 Most Common AI Agent Deployment Patterns](https://aembit.io/blog/ai-agent-architectures-identity-security/) — Dan Kaplan, Nov 2025
- [Northflank: How to Sandbox AI Agents in 2026](https://northflank.com/blog/how-to-sandbox-ai-agents) — Feb 2026
- [Northflank: Firecracker vs gVisor](https://northflank.com/blog/firecracker-vs-gvisor) — Jan 2026
- [E2B: How Manus Uses E2B for Virtual Computers](https://e2b.dev/blog/how-manus-uses-e2b-to-provide-agents-with-virtual-computers) — May 2025
- [Manus: Understanding Manus Sandbox](https://manus.im/blog/manus-sandbox) — Jan 2026
- [OpenAI Codex Security Documentation](https://developers.openai.com/codex/security/)
- [Anthropic: Claude Code Sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing) — Oct 2025
- [Google: Deploy AI Agents on GKE with Agent Sandbox](https://codelabs.developers.google.com/codelabs/gke/ai-agents-on-gke) — Feb 2026
- [Google: Isolate AI Code Execution with Agent Sandbox](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox) — Feb 2026
- [arXiv: Control Plane as a Tool — A Scalable Design Pattern for Agentic AI](https://arxiv.org/html/2505.06817v1) — May 2025
- [NCC Group: Analyzing Secure AI Architectures](https://www.nccgroup.com/research-blog/analyzing-secure-ai-architectures/) — Feb 2024
- [Obsidian Security: Security for AI Agents](https://www.obsidiansecurity.com/blog/security-for-ai-agents) — Oct 2025
- [InfoQ: AI Agents Become Execution Engines](https://www.infoq.com/news/2025/10/ai-agent-orchestration/) — Oct 2025
- [Machine Learning Mastery: 7 Agentic AI Trends for 2026](https://machinelearningmastery.com/7-agentic-ai-trends-to-watch-in-2026/) — Jan 2026
- [DEV Community: Production Fleet Agent Architecture](https://dev.to/nesquikm/i-run-a-fleet-of-ai-agents-in-production-heres-the-architecture-that-keeps-them-honest-3l1h) — Feb 2026
- [DEV Community: gVisor vs Kata vs Firecracker Showdown](https://dev.to/agentsphere/choosing-a-workspace-for-ai-agents-the-ultimate-showdown-between-gvisor-kata-and-firecracker-b10) — Sep 2025
- [Heavybit: Inside Unikraft and Unikernels with Felipe Huici](https://www.heavybit.com/library/podcasts/open-source-ready/ep-30-inside-unikraft-and-unikernels-with-felipe-huici) — Jan 2026
- [Manveer Chawla: AI Agent Sandboxing Guide](https://manveerc.substack.com/p/ai-agent-sandboxing-guide) — Feb 2026
