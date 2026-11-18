import type en from "./en"

// The Chats view's strings in Dutch (`./en`).
export default {
  "chats.title": "Chats",
  "chats.description": "Gesprekken in je Governance-account, dezelfde op deze computer en op je telefoon.",
  "chats.new": "Nieuwe chat",
  "chats.untitled": "Chat zonder titel",
  "chats.recent": "Recent",
  "chats.archived": "Gearchiveerd",
  "chats.placeholder": "Stel een vraag…",
  "chats.placeholder.followUp": "Stel een vervolgvraag…",
  "chats.empty.title": "Begin een gesprek",
  "chats.empty.text": "Het draait op je Governance-account en gaat dus door als deze computer slaapt.",
  "chats.status.loading": "Je chats laden…",
  "chats.status.signed-out": "Meld je in Instellingen aan bij een Governance-instantie om chats te gebruiken.",
  "chats.status.unreachable": "Governance reageert niet. De lijst is mogelijk niet actueel.",
} satisfies Record<keyof typeof en, string>
