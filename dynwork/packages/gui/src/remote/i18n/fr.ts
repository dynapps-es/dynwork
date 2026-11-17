import type en from "./en"

// Remote control's copy in French (`./en`).
export default {
  "remote.title": "Contrôle à distance",
  "remote.description":
    "Utilisez Dynwork depuis votre téléphone. Le téléphone communique avec cet ordinateur via votre instance Governance, chiffré de bout en bout : l'instance ne fait que transmettre ce qu'elle ne peut pas lire.",
  "remote.keywords": "contrôle à distance téléphone mobile appairer qr relais tunnel",
  "remote.unavailable": "Le contrôle à distance n'est pas disponible pour le moment.",
  "remote.toggle.title": "Autoriser la connexion des téléphones appairés",
  "remote.toggle.description":
    "Désactivé par défaut. Tant qu'il est activé, Dynwork garde une connexion sortante vers l'instance active.",
  "remote.confirm.title": "Activer le contrôle à distance ?",
  "remote.confirm.description":
    "Un téléphone que vous appairez peut lire et écrire vos sessions, envoyer des prompts, changer l'agent et le modèle, et répondre aux demandes d'autorisation et aux questions, comme s'il était cet ordinateur. Il ne peut pas ouvrir de terminaux, exécuter de commandes shell ni écrire directement des fichiers. Vous pouvez révoquer un téléphone à tout moment.",
  "remote.confirm": "Activer",
  "remote.status.off": "Désactivé",
  "remote.status.idle": "En attente d'une instance active connectée",
  "remote.status.connecting": "Connexion à {{instance}}…",
  "remote.status.connected": "Connecté via {{instance}}",
  "remote.status.error.insecure": "Le stockage sécurisé de cet appareil est verrouillé",
  "remote.status.error.offline": "Impossible de joindre le relais de {{instance}} ; nouvelle tentative",
  "remote.status.error.refused": "{{instance}} a refusé le contrôle à distance ; nouvelle tentative",
  "remote.fingerprint": "Clé de cet ordinateur : {{fingerprint}}",
  "remote.pair": "Appairer un téléphone",
  "remote.pair.title": "Appairer un téléphone",
  "remote.pair.description":
    "Scannez ce code avec Dynwork sur votre téléphone, connecté à {{instance}}, ou copiez-le et collez-le sous « Enter the code manually ». Il fonctionne une seule fois et cesse de fonctionner à {{time}}.",
  "remote.pair.qr": "Code d'appairage",
  "remote.pair.failed": "Dynwork n'a pas pu créer de code d'appairage.",
  "remote.pair.close": "Terminé",
  "remote.pair.copy": "Copier le code",
  "remote.pair.copied": "Copié",
  "remote.pair.copyFailed": "Dynwork n'a pas pu copier le code.",
  "remote.phones.title": "Téléphones appairés",
  "remote.phones.empty": "Aucun téléphone n'est encore appairé avec cet ordinateur.",
  "remote.phones.online": "Connecté",
  "remote.phones.offline": "Non connecté",
  "remote.phones.paired": "Appairé {{time}}",
  "remote.revoke": "Révoquer",
  "remote.revoke.title": "Révoquer {{name}} ?",
  "remote.revoke.description":
    "Le téléphone est déconnecté immédiatement et doit être appairé à nouveau pour se connecter.",
  "remote.audit.title": "Connexions récentes",
  "remote.audit.empty": "Aucune connexion pour l'instant.",
  "remote.audit.paired": "{{phone}} appairé",
  "remote.audit.connected": "{{phone}} connecté",
  "remote.audit.disconnected": "{{phone}} déconnecté",
  "remote.audit.revoked": "{{phone}} révoqué",
  "remote.audit.refused": "{{phone}} refusé",
  "remote.indicator.one": "{{name}} connecté",
  "remote.indicator.other": "{{count}} téléphones connectés",
  "remote.indicator.title": "Contrôle à distance : téléphones connectés à cet ordinateur",
} satisfies Record<keyof typeof en, string>
