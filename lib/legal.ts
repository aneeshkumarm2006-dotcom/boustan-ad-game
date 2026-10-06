/**
 * Who sends the coupon email (MAIL-04, CASL): legal name, mailing address and contact.
 * Placeholders until Boustan supplies them [Boustan][Legal]; the bracketed values must not ship.
 */
export const LEGAL = {
  name: "[Boustan legal entity name]",
  address: "[Mailing address, Montréal QC]",
  /** Customer-service address; EMAIL_REPLY_TO when set. */
  contact: "[customer-service email]",
} as const;
