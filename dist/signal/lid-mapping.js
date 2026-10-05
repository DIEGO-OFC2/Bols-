/**
 * Maps between phone-number JIDs (PN) and LID JIDs. WhatsApp now addresses
 * many users by an opaque LID; Signal sessions must be keyed by whichever the
 * server uses, so callers store the mapping as it is learned.
 */
import { jidDecode, jidNormalizedUser } from '../wabinary/jid.js';
export class LIDMappingStore {
    pnToLid = new Map();
    lidToPn = new Map();
    async storeLIDPNMappings(pairs) {
        for (const { lid, pn } of pairs) {
            const lidUser = jidDecode(lid)?.user;
            const pnUser = jidDecode(pn)?.user;
            if (!lidUser || !pnUser)
                continue;
            this.pnToLid.set(pnUser, lidUser);
            this.lidToPn.set(lidUser, pnUser);
        }
    }
    async getLIDForPN(pn) {
        const user = jidDecode(pn)?.user;
        if (!user)
            return undefined;
        const lid = this.pnToLid.get(user);
        return lid ? jidNormalizedUser(`${lid}@lid`) : undefined;
    }
    async getPNForLID(lid) {
        const user = jidDecode(lid)?.user;
        if (!user)
            return undefined;
        const pn = this.lidToPn.get(user);
        return pn ? jidNormalizedUser(`${pn}@s.whatsapp.net`) : undefined;
    }
}
//# sourceMappingURL=lid-mapping.js.map