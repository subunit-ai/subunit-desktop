# attachments-on-delete.py — Soft-Delete blankt auch die attachments-Spalte (Koordinator 2026-07-02).
# deleteTeamMessage setzte bisher nur deleted_at + body='' — Anhang-Metadaten blieben sichtbar.
# HINWEIS: Die Spalte ist per media-Welle als TEXT NOT NULL DEFAULT '' angelegt → NULL wäre eine
# Constraint-Verletzung; '' ist das korrekte Blank (listConvoMessages parst '' zu []).
# Die team_msg_attachments-Links bleiben bewusst bestehen (Media-GET prüft Convo-Membership).
# Reihenfolge: NACH wave-reply (deleteTeamMessage) und wave-media-reconciled (attachments-Spalte).
import sys
srv_p, db_p = sys.argv[1], sys.argv[2]
db = open(db_p, encoding="utf-8").read()

if "attachments = ''" in db:
    print("ℹ️  attachments-Blank beim Delete bereits vorhanden — keine Änderung"); sys.exit(0)
if "deleteTeamMessage" not in db or "team_msg_attachments" not in db:
    print("❌ reply-/media-Migration fehlt — bitte ZUERST anwenden."); sys.exit(1)

old = '''export function deleteTeamMessage(convoId: string, msgId: number, sender: string): boolean {
  const r: any = db.run("UPDATE team_messages SET deleted_at = ?, body = '' WHERE id = ? AND convo_id = ? AND sender = ? AND deleted_at IS NULL",
    [Date.now(), msgId, convoId, sender]);
  return (r?.changes ?? 0) > 0;
}'''
new = '''export function deleteTeamMessage(convoId: string, msgId: number, sender: string): boolean {
  // Soft-Delete blankt Body UND Anhang-Metadaten (Spalte ist NOT NULL DEFAULT '' → '' statt NULL).
  const r: any = db.run("UPDATE team_messages SET deleted_at = ?, body = '', attachments = '' WHERE id = ? AND convo_id = ? AND sender = ? AND deleted_at IS NULL",
    [Date.now(), msgId, convoId, sender]);
  return (r?.changes ?? 0) > 0;
}'''
assert db.count(old) == 1, "deleteTeamMessage-Anker nicht eindeutig"
db = db.replace(old, new)
open(db_p, "w", encoding="utf-8").write(db)
print("✅ db.ts: deleteTeamMessage blankt jetzt auch attachments ('')")
