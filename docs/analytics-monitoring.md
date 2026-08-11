# Privacy-conscious visit monitoring

Greenwave currently sends no analytics request and uses no analytics cookie. GitHub Pages publishes static files, but it does not provide a documented visitor analytics dashboard or per-request access logs to the site owner. GitHub's repository **Traffic** page is different: it concerns repository visitors and clones, exposes only the previous 14 days, and is not website analytics.

Sources: [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) and [repository traffic](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-traffic-to-a-repository).

## Option 1: privacy-first basic monitoring

[Cloudflare Web Analytics](https://developers.cloudflare.com/web-analytics/about/) can report page views and visitor estimates without cookies. Enable it only after updating the public privacy notice and confirming the chosen configuration against the applicable data-protection requirements.

This option is useful for broad trends. It does **not** provide an exact count of requests per daily IP address, and its visitor estimate is not an exact count of people.

## Option 2: exact daily network-identifier and request counts

Exact daily request-frequency monitoring requires a custom domain and a controlled edge proxy in front of GitHub Pages.

1. Process the source IP only inside the edge request handler.
2. Generate a secret key that rotates every day.
3. Calculate a daily rotating HMAC identifier with `HMAC-SHA-256(daily key, source IP)` and never store the raw IP in logs or storage.
4. Store only date, daily HMAC identifier and request count. Retain these pseudonymous rows for at most 48 hours.
5. Store only daily aggregates after processing: date, distinct identifier count, total requests and request-count distribution.
6. Delete the per-identifier rows after aggregation.
7. Filter or label known bots. Document that shared NAT addresses, carrier gateways and changing addresses make an IP-derived identifier different from a person or browser session.
8. Before activation, complete a legitimate-interest assessment, data-processing agreement, retention policy, security review and updated privacy notice.

An IP address is personal data under the GDPR, and pseudonymous identifiers can remain personal data too. HMAC pseudonymisation reduces exposure but does not make the processing anonymous. Consult the [European Commission's GDPR guidance](https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/application-gdpr_en) and the [Belgian Data Protection Authority's legitimate-interest guidance](https://www.autoriteprotectiondonnees.be/professionnel/rgpd-/bases-juridiques/interet-legitime) before activation.

No analytics code is enabled: no beacon, edge worker or cookie banner is implemented in the current application. The public statement that Greenwave uses no analytics therefore remains accurate.
