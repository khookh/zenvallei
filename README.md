# Hittekwetsbaarheid Zennevallei

Een lokale, Nederlands- en Engelstalige webkaart voor de hittekwetsbaarheid van de 154 statistische sectoren in Eerstelijnszone Zennevallei. De kaart combineert:

- hittekwetsbaarheidsscores 2026 van het Departement Zorg van de Vlaamse overheid;
- compatibele statistische-sectorgrenzen van Statbel (sectorindeling 2024);
- een OpenStreetMap-achtergrond;
- een optionele Copernicus LCM-10-landbedekkingslaag voor 2020;
- een gedetailleerde Copernicus Urban Atlas-landbedekkingslaag voor 2021;
- een eenvoudige publieksweergave met uitklapbare details voor beleidsmedewerkers.

De applicatie is volledig statisch. Er is geen backend, account, tracking of live scoreberekening in de browser.

## Taal wisselen

De knop `EN`/`NL` in de kop wisselt de volledige interface direct tussen Nederlands en Engels. De kaartpositie, gemeentefilter, geselecteerde sector en open detailsecties blijven daarbij behouden. Elke nieuwe paginaweergave of herlaadbeurt start bewust opnieuw in het Nederlands; de taalkeuze wordt niet opgeslagen in een cookie, URL of lokale browseropslag. Officiële Statbel-sector- en gemeentenamen blijven in beide talen ongewijzigd.

## Wat de interface uitlegt

De actieve kaartlaag krijgt een compacte uitleg met jaartal, methode en gegevensverantwoordelijke. De detailpanelen maken expliciet onderscheid tussen officiële bronwaarden en samenvattingen die tijdens de lokale datavoorbereiding zijn berekend:

- de hitte-, kwetsbaarheids- en eindscores zijn gepubliceerde broncijfers van het Departement Zorg van de Vlaamse overheid en worden niet door deze toepassing herberekend;
- binnen de laag `Hittekwetsbaarheid` kiest `Eindscore`/`Combined`, `Hitte`/`Heat` of `Kwetsbaarheid`/`Vulnerability` welke gepubliceerde score de kaart, legenda, popup en paneelkop tonen. De keuze blijft tijdens de paginaweergave behouden, maar een herlaadbeurt start opnieuw met de eindscore;
- de 154 zones zijn officiële Statbel-sectoren. Departement Zorg gebruikt dezelfde sectorcodes; daarom gebruikt de kaart de compatibele Statbel-sectorgrenzen van 2024;
- LCM-10 bestaat uit automatisch geclassificeerde Copernicus-rasterpixels van 10 m. De dominante klasse en sectorpercentages worden uit die officiële klassen afgeleid;
- Urban Atlas bestaat uit semi-automatisch geproduceerde en visueel geïnterpreteerde Copernicus-polygonen. Groenbedekking en artificialisering zijn lokale aggregaties van de officiële klassen;
- de groenpercentages van LCM-10 en Urban Atlas gebruiken verschillende definities en zijn niet rechtstreeks vergelijkbaar.

De knop `Uitleg`/`About` opent de volledige vergelijking, de verklaring voor de 154 sectoren, de verantwoordelijkheden, methoden en bronlinks.

## Lokaal starten

Vereisten: Node.js 20 of nieuwer en pnpm.

```powershell
pnpm install
pnpm dev
```

Open daarna [http://127.0.0.1:4173](http://127.0.0.1:4173).

De voorbereide GeoJSON- en scorebestanden staan al in `public/data`. De app kan daardoor direct worden gestart. De OSM-achtergrond vereist internettoegang; alle score- en sectordata worden lokaal geladen.

## Data opnieuw opbouwen

Met de meegeleverde bronbestanden:

```powershell
pnpm data:prepare -- --scores "C:\pad\naar\Cijfers_hittekwetsbaarheid_2026.xlsx" --sectors "C:\pad\naar\sh_statbel_statistical_sectors_3812_20240101.geojson.zip"
```

Zonder argumenten downloadt het script de gepinde officiële bronbestanden:

```powershell
pnpm data:prepare
```

Het script stopt bewust wanneer:

- de Zennevallei-filter niet exact 154 score-records oplevert;
- de sector-ID-join niet 100% is;
- gemeente- of statusaantallen afwijken;
- coördinaten niet plausibel zijn;
- vertices verdwijnen tijdens de omzetting van EPSG:3812 naar WGS84.

De bronhashes, tellingen, grenzen, vertexaantallen en naamverschillen staan in `public/data/provenance.json`.

## Copernicus-landbedekking voorbereiden

De officiële LCM-10-bron vereist een gratis Copernicus Data Space-toegangstoken voor de eenmalige download. Het token wordt alleen uit de omgeving gelezen en komt niet in de browserbundel of gegenereerde bronvermelding terecht.

```powershell
$env:CDSE_ACCESS_TOKEN="<tijdelijk-token>"
pnpm landcover:prepare
Remove-Item Env:CDSE_ACCESS_TOKEN
```

Het script downloadt het gepinde officiële product `LCFM_LCM-10_V100_2020_N48E003_cog`, controleert product-ID, bestandsgrootte en MD5, pakt de door CDSE geleverde ZIP-container uit, knipt het raster op de 154 Statbel-sectoren en genereert `public/data/land-cover/land-cover-2020.png` plus `public/data/land-cover.json`. Een reeds gedownload officieel GeoTIFF of CDSE-ZIP kan ook met `--cog <pad>` worden gebruikt; ook dat bestand moet exact met de gepinde officiële MD5 overeenkomen.

De sectorsamenvatting definieert **groenbedekking** bewust als uitsluitend LCM-10-boombedekking (klasse 10) plus grasland (klasse 30); akkerland en de overige klassen tellen niet mee. **Bebouwde oppervlakte** gebruikt klasse 90. Beide percentages worden berekend ten opzichte van de geldige geclassificeerde oppervlakte van de sector. Dezelfde boom-plus-grasdefinitie wordt later gebruikt voor de groenveranderingslaag.

Zolang het raster niet is voorbereid blijft de landbedekkingsknop zichtbaar maar niet selecteerbaar, met een duidelijke lokale melding. De eerdere experimentele groenveranderingsknop is niet meer onderdeel van de interface.

## Urban Atlas 2021 voorbereiden

Urban Atlas gebruikt het officiële FlatGeobuf-product voor FUA `BE001L3` (Bruxelles/Brussel/Leuven). Ook deze download gebruikt het tijdelijke `CDSE_ACCESS_TOKEN` uitsluitend tijdens de voorbereiding:

```powershell
$env:CDSE_ACCESS_TOKEN = $tokenResult.access_token
pnpm urban-atlas:prepare
Remove-Item Env:CDSE_ACCESS_TOKEN
```

Een CDSE-toegangstoken is ongeveer 30 minuten geldig. Vraag daarom een nieuw token aan en start `pnpm urban-atlas:prepare` meteen daarna. De downloader controleert de JWT-vervaltijd vooraf, volgt uitsluitend HTTPS-redirects en behoudt de bearer-header alleen tussen vertrouwde `*.dataspace.copernicus.eu`-hosts. Een `401` geeft een gerichte melding over een verlopen of ongeschikt token.

CDSE heeft het bestand met hetzelfde product-ID op 22 juli 2026 bijgewerkt. De actuele OData-pin is `178900771` bytes met MD5 `eae385ced547b8fab079e33fa81e03fd`; de eerdere officiële CSV-snapshot (`178900904` bytes, MD5 `88ad99ffdf56d86755519771501fb059`) blijft als bekende bronvariant aanvaard. Voor een nieuwe download controleert de pipeline de actuele productnaam, beschikbaarheid, grootte en MD5 voordat de gegevens worden opgehaald. De daadwerkelijk gebruikte variant wordt in het herkomstmanifest geregistreerd.

Een eerder gedownload officieel product kan zonder nieuw token worden verwerkt:

```powershell
pnpm urban-atlas:prepare -- --source "C:\pad\naar\CLMS_UA_LCU_S2021_V025ha_BE001L3..."
```

Het commando controleert de gepinde product-ID, bestandsomvang, MD5, FUA, referentiejaar en EPSG:3035-projectie. Het haalt daarnaast de officiële WMS-stijl op en verifieert elke klassekleur. Daarna snijdt het de Urban Atlas-polygonen exact met de 154 sectoren in de oppervlaktegetrouwe EPSG:3035-projectie. Het genereert:

- `public/data/urban-atlas.geojson` met de sectorfragmenten in WGS84;
- `public/data/urban-atlas.json` met alleen de aanwezige legendaklassen, bronvermelding en statistieken voor 154 sectoren.

De Urban Atlas-laag wordt pas bij de eerste selectie in de browser geladen. **Groenbedekking** omvat exact de drie stedelijke-groenklassen (`14110`, `14120`, `14130`), weilanden (`23000`), bossen (`31000`) en kruidachtige vegetatie (`32000`). Akkerland, permanente teelten, gemengde teeltpatronen en sport- of recreatiegebieden tellen niet mee. **Artificialisering** omvat de geselecteerde niet-groene artificiële polygonen en is geen exacte bodemafdekkingsmeting. No-data en echte dekkingsgaten worden uit de noemer geweerd.

De toegangsaanduiding publiek, privaat of onbekend geldt alleen voor groene stedelijke gebieden, niet voor bossen, kruidachtige vegetatie of weilanden. De app vermeldt ook de door Copernicus gepubliceerde validatiestatus en de datum waarop die status tijdens de voorbereiding werd gecontroleerd.

## Testen en bouwen

```powershell
pnpm test
pnpm test:e2e
pnpm build
pnpm preview
```

De end-to-endtests vervangen live OSM-tegels door een deterministische transparante tegel. Zo blijven screenshots en interactietests onafhankelijk van het netwerk.

## Kaartprovider configureren

Kopieer `.env.example` naar `.env.local` en pas `VITE_TILE_URL` en `VITE_TILE_ATTRIBUTION` aan. De standaard communityserver van OpenStreetMap is alleen bedoeld voor bescheiden lokaal gebruik. Gebruik vóór publieke of intensieve inzet een beheerde of zelfgehoste OSM-afgeleide tegelservice met correcte bronvermelding.

## Interpretatie

De scores zijn relatieve klasseringen ten opzichte van Vlaanderen. De gepubliceerde eindscore kan niet exact worden herberekend uit de afgeronde zichtbare deelscores: de bronmethodiek gebruikt onderliggende waarden, decielen en natuurlijke breekpunten. Daarom toont de applicatie de officiële eind- en deelscores zonder een schijnberekening te maken.

Bronnen:

- [Vlaamse overheid, Departement Zorg: hittekwetsbaarheidskaart en data](https://www.departementzorg.be/nl/hittekwetsbaarheidskaart-vlaanderen)
- [Statbel: statistische sectoren 2024](https://statbel.fgov.be/en/open-data/statistical-sectors-2024)
- [OpenStreetMap: copyright en licentie](https://www.openstreetmap.org/copyright)
- [OpenStreetMap: tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
- [Copernicus Land Monitoring Service: LCM-10 2020](https://land.copernicus.eu/en/products/global-dynamic-land-cover/land-cover-2020-raster-10-m-global-annual)
- [Copernicus Land Monitoring Service: Urban Atlas 2021](https://land.copernicus.eu/en/products/urban-atlas/urban-atlas-2021)
- [Copernicus Land Monitoring Service: data policy](https://land.copernicus.eu/en/data-policy)
