import type en from "./en"

// The Chats view's strings in French (`./en`).
export default {
  "chats.title": "Discussions",
  "chats.description":
    "Des conversations conservées dans votre compte Governance, les mêmes sur cet ordinateur et sur votre téléphone.",
  "chats.new": "Nouvelle discussion",
  "chats.untitled": "Discussion sans titre",
  "chats.recent": "Récentes",
  "chats.archived": "Archivées",
  "chats.placeholder": "Posez votre question…",
  "chats.placeholder.followUp": "Ajoutez une question…",
  "chats.empty.title": "Commencez une conversation",
  "chats.empty.text": "Elle s'exécute sur votre compte Governance et continue même si cet ordinateur se met en veille.",
  "chats.status.loading": "Chargement de vos discussions…",
  "chats.status.signed-out": "Connectez-vous à une instance Governance dans les Réglages pour utiliser les discussions.",
  "chats.status.unreachable": "Governance ne répond pas. La liste n'est peut-être pas à jour.",
} satisfies Record<keyof typeof en, string>
