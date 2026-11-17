# Going live — what the code cannot do for you

The software is the easy part. A real broker needs these before a single client order may reach an exchange:

## Regulatory & memberships
1. Company incorporation with the required net worth.
2. **Trading membership** of NSE and/or BSE (cash + F&O segments) and **clearing membership** (or a clearing arrangement with a professional clearing member).
3. **SEBI stock-broker registration** through the exchange.
4. **Depository Participant** registration with CDSL/NSDL (or a tie-up) for demat accounts.
5. KRA registration, CKYC, PMLA/AML policy with a Principal Officer, grievance redressal (SCORES) and an investor charter.

## Technology approvals
- Exchange-approved trading software (an empanelled vendor's OMS, or your own after exchange approval, mock trading and UAT).
- Exchange connectivity (NNF/FIX over leased line or extranet), DR site, and compliance with SEBI's cybersecurity framework, system audits and VAPT.
- Retail API/algo rules (static IP whitelisting, order tagging, broker-hosted algos) if you expose APIs.

## Integrations to plug in (adapters already marked in code)
| Area | File | Replace with |
|---|---|---|
| Orders | `exchange/nse-gateway.js` | Exchange NNF/FIX gateway |
| Market data | `services/market.js` | Exchange / data-vendor feed |
| PAN / KRA | `services/kyc.js` (`pan` step) | PAN verification + KRA fetch/upload |
| Aadhaar / DigiLocker | `services/kyc.js` (`address`) | DigiLocker / offline e-KYC via licensed partner |
| Bank verification | `services/kyc.js` (`bank`) | Penny-drop API |
| IPV & e-sign | `services/kyc.js` (`ipv`, `esign`) | Video-KYC vendor, Aadhaar eSign (ESP) |
| Pay-in | `services/funds.js` | Payment gateway / bank virtual accounts (auto-reconciled) |
| SMS / email | `services/messaging.js` | DLT-registered SMS provider, SMTP |
| UCC / demat | `services/kyc.js` (`review`) | Exchange UCC upload, depository account opening |

## Until then
Run Chartist Broker as a **simulator / UAT** environment: train staff, test flows, demo to partners, and onboard paper-trading users. The UI clearly labels the simulator.
