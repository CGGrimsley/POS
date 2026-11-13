# Brushbeater POS

A small Windows app for the Yanceyville showroom counter. Staff search for a product, see its price and how many the website shows in stock, add what the customer is buying, and press **Take off website stock**. The sold quantities come off the stock counts on brushbeater.store right away. It can also add received stock, set exact shelf counts, and create new products.

It does not take payments. Charge the customer in the Authorize.net app the way you do now. The app shows a subtotal and a total with sales tax (6.75% for Yanceyville by default) so you know what to charge.

## Installing on a store laptop

1. Download the installer, `Brushbeater-POS-Setup-x.y.z.exe`, from the [Releases page](../../releases) (or from the latest run under **Actions → Build Windows installer → Artifacts**).
2. Run it. Windows may show "Windows protected your PC" because the app isn't code-signed. Click **More info**, then **Run anyway**.
3. Open **Brushbeater POS** from the desktop shortcut. The first time, it opens Settings.
4. In WordPress, go to **WooCommerce → Settings → Advanced → REST API → Add key**. Give it a name like "POS laptop 1", choose **Read/Write**, and generate it. Paste the consumer key and secret into the app's Settings and press Save. One key per laptop makes it easy to shut one off later.

The key is saved encrypted under the Windows user's account in `%APPDATA%\Brushbeater POS\settings.json`. It is never stored in this repository.

## Using it

- Type part of a name or a SKU, or scan a barcode. All the words you type have to match, so "pmag fde" narrows quickly.
- Arrow keys move the highlight, Enter adds the highlighted item. A barcode scanner that types the SKU and presses Enter adds the item in one go.
- Click **Take off website stock** and confirm. The app reads each item's current website count and subtracts from that, so it stays correct even if the website sold one a minute ago.
- **Today** lists what this laptop took off stock today. **Undo** puts a sale back, for a return or a mistake.
- Products refresh from the website every 10 minutes, or press **Refresh products**.
- Items the website doesn't keep a stock count for can't be sold here, since there is nothing to subtract from.

### Receiving stock and shelf counts

The switch at the top of the right panel picks what the list records:

- **Sold** takes the quantities off website stock (the default).
- **Received** adds the quantities, for a delivery or a return. An item with no stock count on the website gets one, starting at the number you enter.
- **Set count** makes each website count exactly the number you enter, for a shelf count. Adding an item fills in its current count so you only change the ones that are off.

Every change shows in **Today** with an **Undo** button.

### Prices

Each search result has a **Price** button. It changes the regular price and the sale price on the website right away. Leave the sale price blank to end a sale. Any scheduled sale dates on the product are cleared so the new price applies now.

### Low stock

**Low stock** lists every item the website tracks with that many or fewer in stock, lowest first. You can pick a category and include hidden (draft) products. **Print** prints just the list, **Export CSV** saves it for Excel, and **Receive** puts an item on the Received list.

### End of day

**Today** puts the showroom and the website side by side for a day. The top line shows items sold and dollars (before tax) in store, on the website, and overall. **Items sold** combines both, per product, with the count in stock now. Below that are this laptop's changes and the day's website orders (processing, completed and on hold count as sales; refunded orders are shown crossed out). The date picker looks back at any earlier day, and **Export CSV** saves the in-store lines and the website order lines with totals for each and overall. Undo is only offered for today. Reading orders uses the same Read/Write API key.

### When the internet drops

The app keeps a copy of the product list on the laptop, so search still works offline. A change that can't reach the website is saved on the laptop, the on-screen counts change to match, and the top bar says "Offline: N change(s) waiting to send". The app tries again every 30 seconds and sends waiting changes in the order they were made. Click that notice (or open **Today**) to see them, send them now, or drop one. If the website refuses a change when it does get through (for example, the product was deleted), it is listed under "needs attention" instead of being retried forever.

### New products

**New product** (top bar) creates a simple product on the website with a name, price, quantity, optional SKU or barcode, category and short description. It is saved as a draft unless you tick "Show it on the website now". Drafts are hidden online but can be sold in the app right away.

Photos: click **Add photos**, drag pictures onto the form, or paste one from the clipboard (up to 6; the first is the main photo). The app shrinks them to 1600px and uploads them to the WordPress media library with the product name as alt text. Uploading needs a WordPress username and **Application Password** in Settings (WordPress: Users → Profile → Application Passwords → Add). WooCommerce API keys can't upload files. A pasted https photo link works without it. If a search or barcode scan finds nothing, the results area offers **Add a new product** with the scanned code filled in.

## Updates

From 0.3.0 on, the app updates itself. It checks GitHub Releases shortly after it opens and every 4 hours (or use **Check for updates** in Settings or the POS menu), downloads a new version in the background, and asks to restart. Settings are kept. This needs the repository to stay public, because the laptops download releases without a GitHub login. Laptops on 0.2.0 or older need 0.3.0 installed by hand once.

## Making a new version

Bump `version` in `package.json` and merge to `main`. The build on `main` sees that there is no release for that version yet, builds the installer, and publishes the release, which the laptops then pick up. No tag is needed. Builds of other branches only upload the installer as an Actions artifact for testing.

## Development

```
npm install
npm test          # unit tests, no network
npm start         # run the Windows app (Electron)
npm run serve     # or run it in a normal browser at http://127.0.0.1:8787
```

`npm run serve` reads settings from `data/settings.json` (git ignores `data/`), or from the file named by `POS_SETTINGS`.

How it fits together:

- `lib/woo.js` talks to the WooCommerce REST API (`/wp-json/wc/v3`).
- `lib/catalog.js` keeps a local copy of products and variations for instant search.
- `lib/stock.js` changes stock counts (sold, received, set count, and undo). Variations that share their parent's stock are combined into one update.
- `lib/queue.js` holds changes made while offline and sends them in order later.
- `lib/products.js` creates new products, changes prices, and lists categories.
- `lib/media.js` uploads product photos to the WordPress media library (Application Password auth).
- `lib/app.js` is the local server for the screen. It only listens on 127.0.0.1 and every request needs a token created at launch, so other web pages can't use it.
- `lib/settings.js` stores settings, encrypting the API key with Windows' own key storage.
- `electron/main.js` is the Windows app window.
