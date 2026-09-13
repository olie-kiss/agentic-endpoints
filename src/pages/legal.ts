import type { Env } from "../types";

/**
 * Legal, privacy and compliance pages.
 *
 * These exist because a service that takes money is judged on the parts
 * nobody demos: a directory reviewer, a payment underwriter, or a cautious
 * buyer's operator all look for them before sending anything. Their absence
 * reads as an abandoned side project regardless of how good the code is.
 *
 * Every factual claim here is one the implementation actually makes true, and
 * the ones that matter are covered by tests. A policy page that overstates
 * what the service does is worse than no page, because it is a promise made
 * to someone who has already paid.
 */

/**
 * Identity facts, in one place and overridable by environment so that
 * changing them is a config change rather than an edit spread across five
 * documents that will drift apart.
 */
export function identity(env: Env) {
  // A malformed address is treated as absent rather than published. The
  // refund policy commits to answering, and a mailto: that cannot receive
  // mail breaks that commitment more quietly than having no address at all.
  const email = env.SUPPORT_EMAIL?.trim();
  const usable = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;

  return {
    entity: env.LEGAL_ENTITY ?? "Oliver Kiss, sole trader",
    jurisdiction: env.LEGAL_JURISDICTION ?? "British Columbia, Canada",
    // A URL, not an invented mailbox: where no address is configured the
    // issue tracker is somewhere that demonstrably receives messages.
    contactUrl:
      env.SUPPORT_URL ?? "https://github.com/olie-kiss/agentic-endpoints/issues",
    contactEmail: usable,
    site: "https://ai.oliverkiss.com",
  };
}

/** Where the "contact" link on each page should point. */
export function contactHref(env: Env): string {
  const id = identity(env);
  return id.contactEmail ? `mailto:${id.contactEmail}` : id.contactUrl;
}

export interface Doc {
  slug: string;
  title: string;
  summary: string;
  sections: { heading: string; body: string[] }[];
}

export function documents(env: Env): Doc[] {
  const id = identity(env);
  const reach = id.contactEmail
    ? `${id.contactEmail} or ${id.contactUrl}`
    : id.contactUrl;

  return [
    {
      slug: "terms",
      title: "Terms of Service",
      summary: `The agreement between you and ${id.entity} when you call these endpoints.`,
      sections: [
        {
          heading: "1. Who this is for",
          body: [
            "These endpoints are sold to businesses, developers and automated systems for use in their own products and workflows. They are not offered to consumers for personal, family or household purposes.",
            "There is no account, no signup and no seat. Calling a paid endpoint and paying for it is acceptance of these terms.",
          ],
        },
        {
          heading: "2. What is being sold",
          body: [
            "A single execution of the requested operation, at the price published in the payment challenge for that endpoint at the moment you call it. Prices are published live at /openapi.json, /llms.txt and in every 402 response, and those are generated from the same configuration that charges you, so a published price cannot disagree with the price applied.",
            "Nothing here is a subscription. Prepaid credit is a balance against future calls at list price, not a recurring plan, and it does not expire.",
          ],
        },
        {
          heading: "3. What is not promised",
          body: [
            "The service is provided as is. No uptime guarantee, no fitness for a particular purpose, and no warranty that an answer is correct, complete or suitable for any decision you make with it.",
            "In particular, /x402/verify reports what a third-party endpoint published when asked. It is a diagnostic, never an endorsement, and a clean result is not a statement that the operator behind that endpoint will deliver anything for your money.",
            "Content returned by /scrape and /pdf-parse originates from third parties. You are responsible for your right to fetch and use it.",
          ],
        },
        {
          heading: "4. Liability",
          body: [
            `To the extent permitted by law, total liability for any claim is limited to the amount you paid for the specific call giving rise to it. Given per-call prices, that is typically a fraction of one cent, and you should size your reliance on this service accordingly.`,
            "Neither party is liable for indirect or consequential loss.",
          ],
        },
        {
          heading: "5. Suspension",
          body: [
            "Access may be rate limited or refused where use threatens the service's availability for others, or breaches the acceptable use policy. Rate limits are applied per client address and are documented in the responses themselves.",
          ],
        },
        {
          heading: "6. Governing law",
          body: [
            `These terms are governed by the laws of ${id.jurisdiction}, and the courts of ${id.jurisdiction} have exclusive jurisdiction.`,
            `Questions: ${reach}`,
          ],
        },
      ],
    },
    {
      slug: "privacy",
      title: "Privacy Policy",
      summary:
        "What is recorded about a caller, what is not, and how long any of it lasts.",
      sections: [
        {
          heading: "1. What is deliberately not collected",
          body: [
            "Client IP addresses are not written to logs. The demand counters record a two-letter country, supplied by the network layer, and a User-Agent string truncated to 120 characters. That is the whole of it.",
            "There are no cookies, no analytics scripts, no third-party trackers and no advertising identifiers, because there is no browser session to attach them to.",
          ],
        },
        {
          heading: "2. The free trial and your address",
          body: [
            "POST /credits/trial derives your evaluation token from your client address using a keyed hash. The address is used to compute the token and is then discarded: what is stored is a hash of the resulting token and a balance. The address itself is never written to storage, and the stored value cannot be reversed back to it.",
            "IPv6 addresses are collapsed to their /64 prefix before use, so the value involved is less specific than the address you connected from.",
          ],
        },
        {
          heading: "3. Content you send",
          body: [
            "Request bodies are processed to produce the response and are not retained, except where retention is the product you asked for:",
            "Vault stores only ciphertext that you encrypted before sending. Encryption keys and plaintext are never transmitted to this service and therefore cannot be read by it, disclosed by it, or produced by it in response to any demand.",
            "Once-key stores an action key, a hash of your payload and any result you record, until its time to live expires (24 hours by default).",
            "Meeting memory stores the transcripts you import, in a namespace you control, until you delete them. DELETE removes the row and its search index entry.",
            "Credit balances store a hash of the token and the amounts. The token itself is never stored, which is why a lost token cannot be recovered.",
          ],
        },
        {
          heading: "4. Processors",
          body: [
            "The service runs on Cloudflare Workers and Durable Objects; Cloudflare processes traffic and stores the data described above on our behalf. Payment settlement is performed by a third-party x402 facilitator and by the Base network, which is a public blockchain.",
            "Payments are public by nature. A settled payment is permanently visible on-chain, including the paying address and amount. That is a property of the payment rail you chose, not something this service can undo.",
          ],
        },
        {
          heading: "5. Your rights",
          body: [
            `Because no account and no identity is collected, most requests about personal data cannot be matched to a person here. Data you stored under a namespace or token you control can be deleted by you at any time using the documented endpoints. For anything else, write to ${reach}.`,
          ],
        },
      ],
    },
    {
      slug: "refunds",
      title: "Refund and Dispute Policy",
      summary:
        "Blockchain payments are irreversible and have no chargebacks, so the protections are built into how the service charges you.",
      sections: [
        {
          heading: "1. A failed call does not charge you",
          body: [
            "This is enforced mechanically rather than promised. Any response at HTTP 400 or above cancels x402 settlement, so a per-call payment for a request that failed is never collected. The payment authorization you signed is not consumed, and retrying is safe.",
            "When paying from a prepaid or trial balance, the price is debited before the work and automatically refunded to your balance in the same request if the call does not succeed. A refund that fails to land is logged as an error naming the ledger and the amount, so it can be replayed by hand.",
          ],
        },
        {
          heading: "2. Delivery",
          body: [
            "The service is delivered the moment the requested operation returns successfully. There is no separate fulfilment step and nothing is shipped.",
          ],
        },
        {
          heading: "3. When a refund is given",
          body: [
            "If a payment settled but the operation did not deliver because of a fault in this service, the call is refunded in full. Report it within 30 days with the request time, the endpoint, and the transaction hash or credit token hash; a response will be sent within 5 business days.",
            "Refunds are not given for a correct answer you did not like, for third-party content that /scrape or /pdf-parse returned faithfully, or for decisions taken on the strength of an /x402/verify diagnostic.",
            "Unused prepaid credit is refundable pro rata at the amount paid, less any credit already spent, for 30 days after purchase. Bonus credit has no cash value.",
          ],
        },
        {
          heading: "4. No chargebacks",
          body: [
            "Settlement is in USDC on the Base network. Blockchain transactions are irreversible and the card-style chargeback does not exist on this rail. Evaluate with the free allowance at POST /credits/trial before committing money; it exists precisely so that no one has to buy first to find out.",
            `Disputes: ${reach}`,
          ],
        },
      ],
    },
    {
      slug: "acceptable-use",
      title: "Acceptable Use Policy",
      summary: "What these endpoints may not be used for.",
      sections: [
        {
          heading: "1. Prohibited use",
          body: [
            "Do not use the service to break the law, infringe others' rights, or attack anyone's infrastructure. Specifically: no unauthorised access, no distribution of malware, no processing of material that is unlawful to possess, and no use of /scrape to evade a site's access controls or to take content you have no right to.",
            "Do not attempt to exhaust or circumvent the rate limits, or to obtain more than one free evaluation allowance by cycling client addresses.",
          ],
        },
        {
          heading: "2. Restricted data",
          body: [
            "The service is not offered for protected health information, payment card data, government identity numbers, or other categories carrying specific regulatory handling duties. Vault holds ciphertext it cannot read, but that is a technical property, not a compliance certification, and it must not be relied on as one.",
          ],
        },
        {
          heading: "3. Enforcement",
          body: [
            "Access may be refused or rate limited without notice where use threatens the service or breaches this policy. Nothing here creates an obligation to monitor traffic, and none is performed beyond the aggregate counters described in the privacy policy.",
          ],
        },
      ],
    },
    {
      slug: "compliance",
      title: "Compliance and Regulatory Status",
      summary: "What this service is, and the things it is deliberately not.",
      sections: [
        {
          heading: "1. Regulatory status",
          body: [
            "This is a software service sold per call. It does not provide cryptocurrency exchange, custody, brokerage, investment or money-transmission services.",
            "No customer funds are held. A payment is settled directly from the payer to a single receiving address at the moment of the call; there is no balance of your money on deposit here. Prepaid credit is a prepayment for future calls of this service only. It is not redeemable for cash, not transferable, and is not a stored-value or e-money instrument.",
            "USDC is a third-party US-dollar-denominated stablecoin. It is neither issued nor guaranteed by this service.",
          ],
        },
        {
          heading: "2. Operator",
          body: [
            `Operated by ${id.entity}, under the laws of ${id.jurisdiction}.`,
            `Contact: ${reach}`,
          ],
        },
        {
          heading: "3. Transparency",
          body: [
            "Live demand and revenue figures are published unauthenticated at /stats and /revenue, including the receiving address and a block explorer link, so any claim made about usage can be checked rather than taken on trust.",
            "The source is public at https://github.com/olie-kiss/agentic-endpoints.",
          ],
        },
        {
          heading: "4. Security reporting",
          body: [
            `Report a vulnerability at ${id.contactUrl}. Please do not exercise a finding against live data beyond what is needed to demonstrate it.`,
          ],
        },
      ],
    },
  ];
}

const STYLE = `
:root{--bg:#0a0a0b;--surface:#141416;--border:#23232a;--text:#e4e4e7;--muted:#71717a;--accent:#6d5cff}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'SF Mono','Fira Code','JetBrains Mono',monospace;background:var(--bg);color:var(--text);line-height:1.7}
.container{max-width:720px;margin:0 auto;padding:3rem 1.5rem}
a{color:var(--accent)}
h1{font-size:1.5rem;font-weight:600;letter-spacing:-.02em;margin-bottom:.5rem}
h2{font-size:.95rem;font-weight:600;margin:2.25rem 0 .75rem;color:var(--text)}
p{margin-bottom:.85rem;font-size:.875rem;color:var(--text)}
.summary{color:var(--muted);font-size:.875rem;margin-bottom:2rem}
.meta{color:var(--muted);font-size:.75rem;margin-top:3rem;border-top:1px solid var(--border);padding-top:1.5rem}
nav{margin-bottom:2.5rem;display:flex;gap:1rem;flex-wrap:wrap;font-size:.8rem}
`;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!,
  );
}

function nav(docs: Doc[], current: string): string {
  return `<nav><a href="/">home</a>${docs
    .map((d) =>
      d.slug === current
        ? `<span style="color:var(--muted)">${escapeHtml(d.title.toLowerCase())}</span>`
        : `<a href="/${d.slug}">${escapeHtml(d.title.toLowerCase())}</a>`,
    )
    .join("")}</nav>`;
}

export function renderDoc(doc: Doc, docs: Doc[], env: Env): string {
  const id = identity(env);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(doc.title)} — agentic-endpoints</title>
<meta name="description" content="${escapeHtml(doc.summary)}" />
<style>${STYLE}</style>
</head>
<body><div class="container">
${nav(docs, doc.slug)}
<h1>${escapeHtml(doc.title)}</h1>
<p class="summary">${escapeHtml(doc.summary)}</p>
${doc.sections
  .map(
    (s) =>
      `<h2>${escapeHtml(s.heading)}</h2>\n${s.body
        .map((p) => `<p>${escapeHtml(p)}</p>`)
        .join("\n")}`,
  )
  .join("\n")}
<p class="meta">${escapeHtml(id.entity)} &middot; ${escapeHtml(id.jurisdiction)} &middot; <a href="${escapeHtml(contactHref(env))}">contact</a><br />
Machine-readable summary: <a href="/.well-known/compliance.json">/.well-known/compliance.json</a></p>
</div></body></html>`;
}

/**
 * The same policies as structured data.
 *
 * Published because the buyers here are programs: an agent deciding whether it
 * is allowed to send something to this service should not have to parse prose
 * to find out.
 */
export function complianceJson(env: Env) {
  const id = identity(env);
  return {
    service: "agentic-endpoints",
    operator: { name: id.entity, jurisdiction: id.jurisdiction },
    contact: id.contactEmail ?? id.contactUrl,
    customer_scope: "business_and_developer_only",
    consumer_offering: false,
    policies: Object.fromEntries(
      documents(env).map((d) => [d.slug.replace(/-/g, "_"), `${id.site}/${d.slug}`]),
    ),
    payment: {
      protocol: "x402",
      network: "eip155:8453",
      asset: "USDC",
      subscriptions: false,
      custody_of_customer_funds: false,
      money_transmission: false,
      chargebacks: false,
      free_evaluation: `${id.site}/credits/trial`,
    },
    data: {
      client_ip_logged: false,
      cookies: false,
      third_party_trackers: false,
      vault_holds_plaintext: false,
      restricted_data_accepted: false,
    },
    transparency: {
      usage: `${id.site}/stats`,
      revenue: `${id.site}/revenue`,
      source: "https://github.com/olie-kiss/agentic-endpoints",
    },
  };
}
