// ========================= template/ContractTemplate.js (updated) =========================
module.exports = `
COLLABGLAM MASTER BRAND–INFLUENCER AGREEMENT (TRI-PARTY)

Effective Date: {{Agreement.EffectiveDateLong}}

This Master Brand–Influencer Agreement (the “Agreement”) is made as of {{Agreement.EffectiveDate}} (the “Effective Date”) by and among: (i) {{Brand.LegalName}}, with its principal place of business at {{Brand.Address}} (“Brand”); (ii) {{Influencer.LegalName}}, with its principal place of business at {{Influencer.Address}} (“Influencer”); and (iii) CollabGlam or CollabGlam.com, with its principal place of business at {{CollabGlam.Address}} (“CollabGlam”). Each of Brand, Influencer, and CollabGlam is a “Party” and together the “Parties.”

1. Purpose; Scope; Territory; Relationship
   a. Purpose. CollabGlam provides a platform connecting brands and influencers for promotional content on social media including YouTube, Instagram, and TikTok (the “Channels”). This Agreement governs rights and obligations for each engagement documented in Schedule A (each, an “SOW”).
   b. Scope. This Agreement applies solely to the Channels. No other platforms are included unless added by written amendment executed by all Parties.
   c. Territory. Unless the SOW states otherwise, the territory is worldwide.
   d. Independent Contractor Status. Influencer is an independent contractor. No employment, partnership, joint venture, or agency is created.

2. Definitions; Language; Precedence; Time Standard
   a. Definitions. Capitalized terms have the meanings set out in Schedule E (Definitions).
   b. Language and Precedence. English governs. If any conflict exists, this Agreement prevails over any SOW, except where the SOW expressly overrides a non-locked topic. All Schedules are incorporated.
   c. Time Standard. Deadlines use {{Time.StandardTimezone}}. “Business Day” means a day other than a Saturday, Sunday, or public holiday in {{Time.StandardJurisdiction}}.

3. Formation of SOW; Versioning; Change Orders
   a. Formation. An SOW is formed when Brand completes required fields in the platform, Influencer accepts, Brand confirms acceptance, and the Parties execute via platform e-signature. If expressly enabled in the SOW, concurrent shipment of product and initial milestone payment constitutes acceptance.
   b. Versioning. The platform maintains immutable version history of offers, counteroffers, and acceptance.
   c. Change Orders. Any post-execution modification to Deliverables, schedules, or fees requires a written change order in the form set out in Schedule O.

4. Services; Deliverables; Acceptance; Makegoods
   a. Services and Deliverables. Influencer shall provide the services and the content specified in Schedule A (the “Deliverables”).
   b. Approvals. If pre-publication review is required, Influencer shall submit drafts via the platform. Brand shall respond within the review window in Schedule A. If Brand does not respond within such window, Influencer may issue a notice of deemed acceptance and proceed after two Business Days unless Brand objects in writing within that period.
   c. Revisions. Included revision rounds are as stated in Schedule A. Additional rounds are billable at the fee in Schedule A.
   d. Acceptance Criteria. A Deliverable is acceptable if it materially conforms to the SOW and Schedule B compliance standards. Minor non-material deviations shall not justify rejection.
   e. Makegoods. If a Deliverable misses the posting window due to Influencer fault, or is removed for non-compliance with Schedule B, Influencer shall, at no additional charge, provide a makegood consisting of re-posting within a mutually agreed window or an equivalent Deliverable.

5. Performance Standards; Escalation
   a. Service Levels. Submission and feedback timelines in Schedule A are binding.
   b. Escalation. Each Party shall designate an escalation contact in Schedule A. Unresolved issues escalate per the timelines in Schedule A.

6. Intellectual Property; Licenses; Derivatives; Third-Party Materials
   a. Ownership. Influencer owns the original copyright in the Deliverables, excluding Brand Assets. Brand owns its trademarks and materials furnished to Influencer (“Brand Assets”).
   b. License to Brand. Upon receipt of applicable milestone payments, Influencer grants Brand the license selected in Schedule K (Usage Rights Matrix) for the duration and geographies selected therein.
   c. Derivative Edits. To the extent selected in Schedule K, Brand may create cut-downs, translations, captions, watermarks, thumbnails, and metadata edits.
   d. Raw Materials. If the SOW requires raw footage, project files, or working files, delivery shall occur per Schedule P. Ownership of raw materials remains with Influencer unless Schedule P expressly transfers ownership.
   e. Third-Party Materials. Influencer shall not include third-party materials requiring separate licenses without Brand’s prior written approval. Where approval is granted, proof of licenses shall be delivered per Schedule Q. Unless Schedule A shifts responsibility, Brand is responsible for commercial music licensing.
   f. Moral Rights. To the extent permitted by law, Influencer waives, or agrees not to assert, moral rights as necessary for the licensed uses.

7. Advertising and Platform Compliance
   a. Legal Compliance. Deliverables must comply with applicable advertising and consumer protection laws in targeted jurisdictions, including the United States Federal Trade Commission Endorsement Guides and materially equivalent regimes.
   b. Disclosures. Influencer shall make clear and conspicuous disclosures of any material connection as required by law.
   c. Truthful Claims. Influencer shall not make false, misleading, or unsubstantiated claims. Brand shall provide substantiation for objective claims it requires.
   d. Platform Policies. Influencer shall comply with YouTube, Instagram, and TikTok policies.
   e. Corrections. Upon notice of a compliance deficiency, Influencer shall promptly implement non-substantive corrections without counting against revision limits.
   f. Prohibited Conduct. Deliverables shall not include illegal content, hate speech, harassment, or similar brand-safety risks.

8. Global Standards; Sensitive Sectors; Accessibility; AI and Synthetic Media
   a. Jurisdictional Standards. The Parties shall adhere to materially applicable local regimes, including where relevant CMA/ASA (UK), EU UCPD, ACMA (AU), and comparable authorities.
   b. Age-Gated and Sensitive Sectors. Where age-gating or sector-specific rules apply, the Parties shall implement controls before publication. The minors-specific requirements in Schedule I apply when any minor participates or is targeted.
   c. Accessibility. Where reasonably practicable, video Deliverables shall include platform-native captions and reasonable accessibility accommodations.
   d. AI and Synthetic Media. Without express written consent, no Party shall train, fine-tune, or otherwise use any Deliverables or Brand Assets to develop or improve machine learning or artificial intelligence models. No synthetic impersonation of any person is permitted without that person’s written consent. If synthetic media is used, required legal labeling shall be applied.

9. Confidentiality
   a. Definition. “Confidential Information” means non-public information disclosed by a Party that is identified as confidential or that should reasonably be understood to be confidential.
   b. Obligations. The Receiving Party shall use Confidential Information solely to perform under this Agreement and protect it with at least reasonable care.
   c. Duration. Confidentiality obligations survive for three years after termination; trade secrets survive while they remain trade secrets.
   d. Exceptions. Exclusions apply for independently developed, rightfully received, public, or legally compelled disclosures.

10. Payments; Escrow; Invoicing; Taxes; Currency; AML/KYC; Clawback
   a. Fees and Milestones. Fees, currency, milestones, and net terms are set out in Schedule A.
   b. Escrow. Unless disabled in Schedule A, payments shall be deposited into CollabGlam escrow and released upon milestone completion as recorded in the platform.
   c. Invoicing. Where invoicing is used, Influencer shall issue invoices containing required tax identifiers and line items consistent with Schedule A.
   d. Currency Conversion. If payment occurs in a different currency, conversion shall be based on {{Payments.FXSource}} on the payment date unless Schedule A states another source. FX fees shall be allocated as stated in Schedule A.
   e. Taxes. Amounts are exclusive of VAT, GST, and similar taxes unless stated otherwise. Each Party is responsible for its own taxes. Required tax forms, including W-9, W-8BEN, or W-8BEN-E, shall be provided.
   f. AML/KYC and Sanctions Screening. CollabGlam may perform and the Parties shall cooperate with AML/KYC and sanctions screenings prior to each payout. Failure or refusal to pass screening permits payment suspension or termination for cause.
   g. Late Payment. Overdue sums accrue interest at 1.5 percent per month or the maximum permitted by law, whichever is lower.
   h. Chargebacks. Bad-faith chargebacks constitute a material breach. CollabGlam may suspend accounts, recover fees, and offset against funds held.
   i. Clawback and Offsets. In cases of proven fraud or material breach causing refund or chargeback, amounts may be offset against future payments for the same SOW, subject to law.

11. Metrics; Invalid Traffic; Verification; Remedies
   a. Metrics Evidence. Influencer shall provide live links and insights or screenshots within 48 hours of publication and a day-30 snapshot upon request.
   b. Invalid Traffic. “Invalid Traffic” has the meaning in Schedule L. If Invalid Traffic materially distorts results, remedies in Schedule L shall apply.
   c. Verification. Brand may request third-party verification once per SOW per Schedule L. Costs are borne by Brand unless variance thresholds are exceeded.

12. Data Protection; Security; Account Access; E-Sign
   a. Data Minimization. Personal data shall be limited to what is necessary for SOW performance.
   b. Compliance. Each Party shall comply with applicable data protection laws, including GDPR, UK GDPR, and CCPA/CPRA, as applicable.
   c. Security. Each Party shall implement reasonable technical and organizational measures and notify affected Parties without undue delay of a personal data breach.
   d. DPA. Where one Party processes personal data on behalf of another beyond independent controller roles, the Data Processing Addendum at Schedule D applies.
   e. Ad Accounts and Pixels. Access shall be least-privileged and shall be revoked upon SOW completion.
   f. E-Signature Enforceability. Electronic signatures are enforceable under ESIGN, UETA, and, where applicable, eIDAS, without prejudice to any mandatory local requirements.

13. Product Handling; Shipment; Returns
   a. Shipment Timing. Where product is required, Brand shall deliver by the date in Schedule A.
   b. Ownership. Unless Schedule A requires return, Influencer may retain product after final approval. If return is required, Brand shall provide prepaid labels and instructions.
   c. Care. Influencer shall exercise reasonable care while product is in Influencer’s possession, excluding manufacturer defects or carrier damage.

14. Takedown; Corrective Action; Morals and Reputation
   a. Takedown. If a Deliverable appears unlawful, infringes rights, or violates Channel policies, CollabGlam may require temporary unlisting or removal pending cure.
   b. Corrections. Influencer shall promptly implement required compliance corrections.
   c. Morals. A Party may suspend performance where association with another Party would reasonably cause material reputational harm due to criminal conduct, hate speech, or similar scandal substantiated by credible evidence.
   d. Crisis Protocol. Public-facing coordination shall follow Schedule M.

15. Exclusivity; Non-Circumvention
   a. Category Exclusivity. If selected in Schedule A, Influencer shall refrain from promoting listed competitors within the exclusivity window after go-live.
   b. Non-Circumvention. For twelve months after the last milestone under an SOW, Brand and Influencer shall not intentionally circumvent CollabGlam to contract for substantially similar services first initiated on the platform, unless CollabGlam consents in writing or Brand pays a buy-out fee of fifteen percent of the contracted value.

16. Insurance
   a. Insurance Requirements. If required by Schedule J, Influencer shall maintain insurance with limits and coverages stated therein and provide a certificate of insurance upon request. Where required, Brand shall be named as additional insured on a primary and non-contributory basis.

17. Representations and Warranties
   a. Mutual. Each Party represents and warrants authority to enter into this Agreement and compliance with law, including sanctions and export controls.
   b. Influencer. Influencer represents and warrants originality of Deliverables (excluding Brand Assets), compliance with Schedule B and Channel policies, and that statements reflect honest opinions and experiences.
   c. Brand. Brand represents and warrants that Brand Assets and required claims are lawful and non-infringing and that Brand will provide substantiation for objective claims.

18. Indemnification
   a. By Influencer. Influencer shall defend, indemnify, and hold harmless Brand and CollabGlam against claims arising from infringement by Deliverables (excluding Brand Assets), violations of Schedule B, or Influencer’s breach.
   b. By Brand. Brand shall defend, indemnify, and hold harmless Influencer and CollabGlam against claims arising from Brand Assets, unsubstantiated or unlawful product claims, product liability, or Brand’s breach.
   c. Procedure. The indemnified Party shall provide prompt notice, reasonable cooperation, and grant control of the defense to the indemnifying Party, subject to participation at the indemnified Party’s expense.

19. Limitations of Liability
   a. Exclusions. Except for willful misconduct or fraud, indemnification obligations, or breaches of Section 9, no Party is liable for indirect, incidental, special, consequential, exemplary, or punitive damages.
   b. Cap. CollabGlam’s total liability for any SOW shall not exceed the greater of platform fees received by CollabGlam for that SOW or USD 1,000.

20. Material Platform Change; Shadow-Ban or Suppression
   a. Material Platform Change. If a Channel materially changes policies or ad tools in a manner that makes performance commercially impracticable, the Parties shall in good faith renegotiate timelines and fees. If no agreement is reached within seven Business Days, either Party may terminate the affected SOW without fault, with escrowed amounts reconciled pro rata.
   b. Shadow-Ban or Suppression. If a Deliverable is materially suppressed beyond normal variance due to documented platform enforcement unrelated to breach by Influencer, the Parties shall implement remedies consistent with Schedule L.

21. Dispute Resolution; Mediation; Arbitration; Governing Law; Injunctive Relief
   a. Governing Law. This Agreement is governed by the laws of {{Time.StandardJurisdiction}} without regard to conflict-of-law rules.
   b. Mediation. As a condition precedent to arbitration, the Parties shall mediate any dispute in good faith for at least ten Business Days after a written mediation request.
   c. Arbitration. Unresolved disputes shall be finally resolved by binding arbitration administered by the American Arbitration Association under its Commercial Arbitration Rules. The seat shall be {{Arbitration.Seat}} and the language English. Judgment may be entered in any court of competent jurisdiction.
   d. Fees. The arbitrator may award reasonable costs and attorneys’ fees to the prevailing Party.
   e. Injunctive Relief. A Party may seek temporary injunctive relief in court to preserve the status quo or protect intellectual property or Confidential Information.

22. Force Majeure
   a. No Party is liable for delay or failure to perform due to events beyond reasonable control. The impacted Party shall notify the others and mitigate. Posting windows shall be extended for the duration of the force majeure event.

23. Sanctions; Export; Anti-Corruption; Anti-Spam
   a. Each Party represents it is not subject to sanctions and will comply with sanctions, export controls, anti-corruption, and anti-spam laws. Deliverables shall not be targeted to embargoed territories contrary to law.

24. Notices
   a. Routine communications may occur via the platform. Formal notices shall be sent to the addresses and emails listed above, with a copy to legal@collabglam.com, and are deemed received upon confirmed courier delivery or email transmission with confirmation.

25. Assignment; Change of Control; Insolvency
   a. Assignment. Brand and Influencer may not assign this Agreement or any SOW without prior written consent of the other Parties. CollabGlam may assign to an affiliate or in connection with a merger, acquisition, or sale of substantially all assets.
   b. Change of Control. A Party undergoing a change of control shall notify the other Parties within a reasonable period and ensure continuity of licenses granted for fully paid Deliverables.
   c. Insolvency. Upon insolvency proceedings, non-insolvent Parties may terminate outstanding SOWs for cause. Licenses already paid for shall continue per their terms.

26. Records; Audit Trail; Evidence Preservation
   a. The platform maintains records of SOWs, approvals, submissions, and milestone events. The Parties consent to CollabGlam’s retention of such records for compliance and dispute resolution.

27. Platform Terms; Fees; Suspension; Audit Rights
   a. Platform Fees. Brand authorizes deduction of platform and processing fees as published in the dashboard at SOW acceptance.
   b. Suspension. CollabGlam may suspend accounts or SOWs for repeated violations, fraud, or non-payment after notice.
   c. Limited Audit. CollabGlam may conduct a limited audit of SOW performance records where reasonably necessary to verify milestone completion or suspected fraud.

28. Independent-Contractor Safeguards; Non-Solicit
   a. Contractor Safeguards. Influencer shall provide tools, select methods, and control scheduling subject to SOW outcomes. No benefits, withholdings, or supervision constituting employment shall be imposed.
   b. Non-Solicit. During the Term and for six months thereafter, the Parties shall not knowingly solicit for employment the other Party’s employees or exclusive roster talent directly involved in an SOW, excluding general solicitations not targeted at such personnel.

29. Entire Agreement; Amendments; Waiver; Severability; Counterparts; Survival Map
   a. Entire Agreement. This Agreement, Schedules, and executed SOWs constitute the entire agreement and supersede prior or contemporaneous agreements on the subject matter.
   b. Amendments. Amendments must be in writing and executed via platform e-signature by all Parties. Locked clauses may not be modified without CollabGlam’s written consent.
   c. Waiver. Failure to enforce any provision is not a waiver of future enforcement.
   d. Severability. If any provision is held invalid or unenforceable, the remainder remains effective.
   e. Counterparts; E-Signatures. Counterparts and electronic signatures are valid and binding.
   f. Survival. The survival durations in Schedule N apply.


Influencer Acceptance Details (Complete to Accept)

The Influencer provides the following information for contracting, notices, and (where applicable) tax and payment administration. These fields populate the Agreement and are incorporated by reference.

[[Influencer.AcceptanceDetailsTableHTML]]

Signatures

Brand: {{Brand.LegalName}}
By: __________________________
Name: {{Brand.ContactName}}
Title: ________________________
Date: {{Agreement.EffectiveDate}}

Influencer: {{Influencer.LegalName}}
By: __________________________
Name: {{Influencer.ContactName}}
Title: ________________________
Date: {{Agreement.EffectiveDate}}

CollabGlam: CollabGlam LLC
By: __________________________
Name: {{CollabGlam.SignatoryName}}
Title: ________________________
Date: {{Agreement.EffectiveDate}}

Schedule A – Statement of Work (SOW)

— Reference Notes for Drafting —
• Deliverable “Type” = content category (see Schedule E examples).
• “Format” = HOW the content is delivered (technical/media specs: file type, aspect ratio, resolution, orientation).
• Each Deliverable’s “Posting Window” functions as the Go-Live window for that Deliverable.

1. Campaign Title: {{Campaign.Title}}
2. Territory: {{Campaign.Territory}} (default Worldwide)
3. Platforms: {{Campaign.Channels}}
4. Deliverables (rendered table includes Type, Quantity, Format/Duration, Posting Window, Draft Requirement (and Draft Due), Minimum Live, Tags/Handles, Captions/Links, Disclosures, and Whitelisting/Spark Ads toggles):
[[SOW.DeliverablesTableHTML]]

5. Approvals and Service Levels:
   a. Brand review window: {{Approval.BrandResponseWindow}} Business Days.
   b. Included revision rounds: {{Approval.RoundsIncluded}}.
   c. Additional revision fee: {{Approval.AdditionalRevisionFee}}.

6. Usage Rights Matrix Reference: Schedule K selections (Bundle summary and table render in Schedule K).

7. Compensation and Payments:
   a. Total Fee and currency: {{Comp.TotalFee}} {{Comp.Currency}}.
   b. Milestones and triggers: {{Comp.MilestoneSplit}}.
   c. Net terms if escrow is not used: {{Comp.NetTerms}}.
   d. Payment method: {{Comp.PaymentMethod}}.

8. Tracking and Reporting:
   a. Affiliate link or UTM parameters, if applicable.
   b. Insights or screenshots within 48 hours and a day-30 snapshot upon request.

9. Exclusivity:
   a. Exclusivity window after go-live: {{Exclusivity.WindowHoursAfterPost}} hours.

10. Product Handling:
    a. Shipment date required: {{ProductShipment.RequiredDate}}.
    b. Return required or not: {{ProductShipment.ReturnRequired}}.

11. Contacts and Escalation:
    a. Primary contacts for each Party.
    b. Escalation contact and timelines.

12. Special Terms:
    a. Any specific provisions expressly agreed to override SOW defaults consistent with Section 2.
    b. Whitelisting/Spark Ads access, read-only insights, and any platform permissions (if enabled) shall be granted via least-privilege access for the SOW term only and revoked upon completion.

Schedule B – Advertising and Platform Compliance Addendum

1. Legal Standards. Deliverables shall comply with applicable advertising and consumer protection law in targeted jurisdictions.
2. Disclosures. Influencer shall provide clear and conspicuous disclosures of material connections proximate to endorsements.
3. Claims. Influencer shall not make objective claims without reasonable substantiation. Brand shall supply substantiation on request.
4. Platform Policies. Influencer shall comply with YouTube, Instagram, and TikTok policies.
5. Corrections. Influencer shall promptly implement compliance corrections.
6. Prohibitions. No undisclosed incentives, review-gating, impersonation, or unlawful dark patterns.
7. Sensitive Sectors. Age-gated and special-category requirements shall be implemented before publication.
8. Accessibility. Use captions and reasonable accessibility measures where practicable.
9. AI and Synthetic Media. Label synthetic media where required; no impersonation without consent.

Schedule C – Platform Terms and Dispute Process

1. Fees. Platform and processing fees shall be as published in the CollabGlam dashboard at SOW acceptance.
2. Escrow. Milestones require submission of specified artifacts before escrow release.
3. Dispute Process. Parties shall first use the platform’s evidence-based dispute flow before arbitration.
4. Suspension. CollabGlam may suspend accounts or SOWs for repeated violations, fraud, or non-payment after notice.
5. Records. Transaction logs, approvals, and milestones may be retained as evidence.

Schedule D – Data Processing Addendum

1. Subject Matter and Duration. Processing personal data solely to perform the SOW for the term of this Agreement.
2. Roles. Each Party is an independent controller of its own data; where one Party processes on behalf of another, processor obligations apply to that processing.
3. Security. Reasonable technical and organizational measures shall be implemented.
4. Breach Notice. Notice without undue delay including incident description, likely consequences, and mitigation.
5. Sub-processors. Permitted subject to materially equivalent obligations.
6. Cross-Border Transfers. Appropriate transfer mechanisms shall be used where required by law.
7. Data Minimization and Retention. Collect only what is necessary and retain only as required by law or this Agreement.

Schedule E – Definitions (with drafting guidance)

1. Business Day has the meaning in Section 2.
2. Platforms means the social media channels selected in the SOW (e.g., Instagram, YouTube, TikTok).
3. Deliverables means the content and outputs specified in Schedule A.
4. Deliverable Type means the content category (examples: Video; Reel/Short/TikTok; Static Post (Image); Carousel Post; Story (Single); Story Set (Multiple frames); UGC Video; YouTube Integration (Mid-roll/Pre-roll); YouTube Dedicated Video; Live Stream; Blog Post (optional); Whitelisting Asset (if required); Custom Deliverable).
5. Format means HOW the content is delivered (technical/media specification). Common examples include:
   - File type: JPG/PNG (images); MP4/MOV (videos)
   - Orientation/Layout: vertical / horizontal / square
   - Resolution & Aspect: 1080×1920 (9:16); 1920×1080 (16:9); Square 1080×1080 (1:1)
   - RAW/Codec: e.g., ProRes; 4K source
6. Posting Window (Go-Live Window) means the start/end dates in which the Deliverable must be posted live.
7. Draft Required means the Deliverable requires pre-publication review; Draft Due Date means the date by which the draft must be submitted.
8. Revision Rounds Included means the number of included cycles of edits/notes (additional rounds may incur the Additional Revision Fee).
9. Live Retention means the minimum period the Deliverable must remain published (measured in hours or months as specified in the SOW/table).
10. Organic Use means unpaid reposting or sharing on Brand-owned social channels and websites as selected in Schedule K.
11. Paid Digital Use means paid promotion or use in Brand digital advertising and retailer sites as selected in Schedule K.
12. Brand Assets means trademarks and materials furnished by Brand.
13. Invalid Traffic has the meaning in Schedule L.

Schedule F – Jurisdiction Addendum: United States

1. FTC Endorsement Guides. Parties shall comply with the FTC Endorsement Guides.
2. COPPA. Where content is directed to children under 13, Parties shall comply with COPPA and platform rules.
3. State Laws. Applicable state unfair competition and privacy laws apply.

Schedule G – Jurisdiction Addendum: United Kingdom and European Union

1. ASA/CAP. Comply with ASA and CAP Code in the UK.
2. UCPD. Comply with the Unfair Commercial Practices Directive in the EU.
3. Platform-Specific Labels. Use required ad labels where applicable.

Schedule H – Promotions and Sweepstakes Annex

1. Compliance. Promotions must comply with applicable local law, platform policy, and disclosure rules.
2. Rules. Official rules shall be hosted by Brand; Influencer shall link or reference required elements.
3. No Consideration. Where required, entry may not require consideration beyond minimal tasks permitted by law.

Schedule I – Minors and Child-Directed Content Annex

1. Parental Consent. Where minors appear, obtain appropriate parental consent and releases.
2. Safety. Comply with platform minor safety policies and industry best practices.
3. Advertising Restrictions. Follow stricter advertising rules for content directed to minors.

Schedule J – Insurance Requirements

1. When Required. If Schedule J is selected in the SOW, Influencer shall maintain insurance as stated.
2. Certificate. Provide certificate upon request; where required, Brand shall be named as additional insured on a primary and non-contributory basis.
3. Limits. Coverage limits and types as specified in the SOW.

Schedule K – Usage Rights Matrix

Selected Bundle (summary):
[[Usage.BundleSummary]]

Bundle Details:
[[Usage.BundleTableHTML]]

1. Grant. Upon receipt of applicable milestone payments, Influencer grants Brand the selected usage rights:
   a. Organic Use: reposting on Brand-owned social channels and websites.
   b. Paid Digital Use: paid ad use on digital platforms and retailer sites.
   c. Derivative Edits: cut-downs, captions, translations, thumbnails, metadata edits.
2. Territory and Duration. As selected in the SOW; otherwise defaults apply per Agreement.
3. Restrictions. No use beyond selected boxes without a signed change order in Schedule O.

Schedule L – Metrics Verification and Invalid Traffic

1. Evidence. Influencer shall provide live links and insights or screenshots within 48 hours of publication and a day-30 snapshot upon request.
2. Invalid Traffic. If Invalid Traffic materially distorts results, the Parties shall apply remedies as outlined below.
3. Verification. Brand may request a third-party verification once per SOW; costs borne by Brand unless variance thresholds are exceeded.
4. Remedies. Makegoods, additional distribution, or proportional adjustments as reasonably agreed.

Schedule M – PR Crisis Protocol

1. Coordination. Parties shall coordinate on public statements during material issues impacting Deliverables.
2. Escalation. Use designated escalation contacts; time-bound approvals for statements.
3. Mitigation. Temporary unlisting or takedown may be required pending corrections.

Schedule N – Survival Schedule

1. Surviving Sections. The following survive termination or expiration: Sections 6 (IP/Licenses) to the extent of ongoing licenses, 7–9, 10(d)–(i), 11, 12, 14, 18–19, 21, 23–27, and Schedule L obligations.

Schedule O – Change Order Form

1. Use. Required for post-execution modifications to Deliverables, schedules, or fees.
2. Contents. Include revised scope, timelines, fees, and any usage changes.
3. Signatures. Executed via platform e-signature by all Parties.

Schedule P – Raw Footage and Asset Delivery

1. Scope. If required in the SOW, Influencer shall deliver raw footage, project files, and working files in stated formats within the delivery timeline.
2. Security. Files shall be transmitted via a secure method and retained by Influencer for ninety days unless otherwise stated.
3. Ownership. Ownership remains with Influencer unless the SOW expressly transfers ownership and fee.

Schedule Q – Proof of License Deliverables

1. Proofs. Where third-party materials are used, Influencer shall provide proof of license, including license terms, permitted uses, and durations.
2. Music. Unless the SOW assigns responsibility to Influencer, Brand remains responsible for commercial music licensing.
`;
