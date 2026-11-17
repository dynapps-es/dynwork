import type en from "./en"

// Remote control's copy in Dutch (`./en`).
export default {
  "remote.title": "Bediening op afstand",
  "remote.description":
    "Gebruik Dynwork vanaf je telefoon. De telefoon praat met deze computer via je Governance-instantie, end-to-end versleuteld: de instantie geeft alleen door wat ze niet kan lezen.",
  "remote.keywords": "bediening op afstand telefoon mobiel koppelen qr relay tunnel",
  "remote.unavailable": "Bediening op afstand is nu niet beschikbaar.",
  "remote.toggle.title": "Gekoppelde telefoons laten verbinden",
  "remote.toggle.description":
    "Standaard uit. Zolang het aan staat, houdt Dynwork een uitgaande verbinding met de actieve instantie open.",
  "remote.confirm.title": "Bediening op afstand aanzetten?",
  "remote.confirm.description":
    "Een telefoon die je koppelt, kan je sessies lezen en schrijven, prompts sturen, de agent en het model wijzigen, en toestemmingsverzoeken en vragen beantwoorden, alsof het deze computer is. Hij kan geen terminals openen, geen shellopdrachten uitvoeren en geen bestanden rechtstreeks schrijven. Je kunt een telefoon op elk moment intrekken.",
  "remote.confirm": "Aanzetten",
  "remote.status.off": "Uit",
  "remote.status.idle": "Wacht op een actieve instantie waarbij je bent aangemeld",
  "remote.status.connecting": "Verbinden met {{instance}}…",
  "remote.status.connected": "Verbonden via {{instance}}",
  "remote.status.error.insecure": "De beveiligde opslag van dit apparaat is vergrendeld",
  "remote.status.error.offline": "De relay van {{instance}} is niet bereikbaar; nieuwe poging",
  "remote.status.error.refused": "{{instance}} heeft bediening op afstand geweigerd; nieuwe poging",
  "remote.fingerprint": "Sleutel van deze computer: {{fingerprint}}",
  "remote.pair": "Telefoon koppelen",
  "remote.pair.title": "Telefoon koppelen",
  "remote.pair.description":
    'Scan deze code met Dynwork op je telefoon, aangemeld bij {{instance}}, of kopieer hem en plak hem onder "Enter the code manually". Hij werkt één keer en werkt niet meer vanaf {{time}}.',
  "remote.pair.qr": "Koppelcode",
  "remote.pair.failed": "Dynwork kon geen koppelcode maken.",
  "remote.pair.close": "Klaar",
  "remote.pair.copy": "Code kopiëren",
  "remote.pair.copied": "Gekopieerd",
  "remote.pair.copyFailed": "Dynwork kon de code niet kopiëren.",
  "remote.phones.title": "Gekoppelde telefoons",
  "remote.phones.empty": "Er is nog geen telefoon aan deze computer gekoppeld.",
  "remote.phones.online": "Verbonden",
  "remote.phones.offline": "Niet verbonden",
  "remote.phones.paired": "Gekoppeld {{time}}",
  "remote.revoke": "Intrekken",
  "remote.revoke.title": "{{name}} intrekken?",
  "remote.revoke.description":
    "De verbinding met de telefoon wordt meteen verbroken en hij moet opnieuw worden gekoppeld om te verbinden.",
  "remote.audit.title": "Recente verbindingen",
  "remote.audit.empty": "Nog geen verbinding.",
  "remote.audit.paired": "{{phone}} gekoppeld",
  "remote.audit.connected": "{{phone}} verbonden",
  "remote.audit.disconnected": "{{phone}} verbroken",
  "remote.audit.revoked": "{{phone}} ingetrokken",
  "remote.audit.refused": "{{phone}} geweigerd",
  "remote.indicator.one": "{{name}} verbonden",
  "remote.indicator.other": "{{count}} telefoons verbonden",
  "remote.indicator.title": "Bediening op afstand: telefoons verbonden met deze computer",
} satisfies Record<keyof typeof en, string>
