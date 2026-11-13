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

### New products

**New product** (top bar) creates a simple product on the website with a name, price, quantity, optional SKU or barcode, category and short description. It is saved as a draft unless you tick "Show it on the website now". Drafts are hidden online but can be sold in the app right away. Add photos and the full description in WordPress before publishing. If a search or barcode scan finds nothing, the results area offers **Add a new product** with the scanned code filled in.

## Making a new version

Bump `version` in `package.json`, merge to `main`, then tag it (`git tag v0.2.0 && git push origin v0.2.0`). GitHub builds the installer and attaches it to a release. Run the new installer on each laptop; settings are kept.

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
- `lib/products.js` creates new products and lists categories.
- `lib/app.js` is the local server for the screen. It only listens on 127.0.0.1 and every request needs a token created at launch, so other web pages can't use it.
- `lib/settings.js` stores settings, encrypting the API key with Windows' own key storage.
- `electron/main.js` is the Windows app window.
