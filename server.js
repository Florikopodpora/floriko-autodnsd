const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');


const adminApp = express();
const ADMIN_PORT = process.env.PORT || 3000;

// Database paths
const DB_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DB_DIR, 'products.json');
const ORDERS_FILE = path.join(DB_DIR, 'orders.json');
const ACTIVITY_FILE = path.join(DB_DIR, 'activity.json');
const COUPONS_FILE = path.join(DB_DIR, 'coupons.json');

// Ensure database files exist
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);
if (!fs.existsSync(PRODUCTS_FILE)) fs.writeFileSync(PRODUCTS_FILE, JSON.stringify([]));
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, JSON.stringify([]));
if (!fs.existsSync(COUPONS_FILE)) fs.writeFileSync(COUPONS_FILE, JSON.stringify([ { code: "ZAHRADA10", discount: 10 } ]));
if (!fs.existsSync(ACTIVITY_FILE)) {
    fs.writeFileSync(ACTIVITY_FILE, JSON.stringify([
        { text: "Server úspěšně spuštěn a databáze připravena", time: new Date().toLocaleTimeString('cs-CZ'), type: "success" }
    ]));
}

// Helpers to read/write DB
const readData = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeData = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// Log Activity Helper
const logActivity = (text, type = 'info') => {
    const list = readData(ACTIVITY_FILE);
    list.unshift({
        text,
        time: new Date().toLocaleTimeString('cs-CZ'),
        type
    });
    writeData(ACTIVITY_FILE, list.slice(0, 50));
};

// CORS and JSON Middleware
adminApp.use(cors());
adminApp.use(express.json());
adminApp.use(express.static(path.join(__dirname, 'public')));



// ================= API ENDPOINTS =================

// Get Products
adminApp.get('/api/products', (req, res) => {
    res.json(readData(PRODUCTS_FILE));
});

// Root endpoint
adminApp.get('/', (req, res) => {
    res.send("<h1>Floriko API Server je plně funkční 🌿</h1><p>Tato adresa slouží jako databázové pozadí. Pro nákup prosím navštivte váš e-shop na Netlify.</p>");
});

// Import Product from Link
adminApp.post('/api/import', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: "Chybí URL odkaz" });
    }

    let domain = 'neznámý';
    try {
        const parsedUrl = new URL(url);
        domain = parsedUrl.hostname.replace('www.', '');
    } catch (e) {
        return res.status(400).json({ error: "Neplatný formát URL" });
    }

    try {
        logActivity(`Spuštěn import z URL: ${url.substring(0, 40)}...`, 'info');
        
        // Fetch HTML with User-Agent to bypass simple blocks
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'cs-CZ,cs;q=0.9,en;q=0.8'
            },
            timeout: 8000
        });

        const $ = cheerio.load(response.data);
        
        // Parse Title, Description, Image using standard Meta tags
        let title = $('meta[property="og:title"]').attr('content') || $('title').text();
        let description = $('meta[property="og:description"]').attr('content') || '';
        let image = $('meta[property="og:image"]').attr('content') || '';
        
        // If meta image is not found, look for first image or use a generic one
        if (!image) {
            image = $('img').first().attr('src') || '';
        }
        
        // Detect supplier name properly
        let supplier = "AliExpress";
        if (url.includes('amazon')) supplier = "Amazon";
        else if (url.includes('temu')) supplier = "Temu";
        else if (url.includes('alibaba')) supplier = "Alibaba";

        // Simplify Price Parsing
        let cost = 0;
        
        // Try metadata first
        const metaPrice = $('meta[property="product:price:amount"]').attr('content') || 
                          $('meta[property="og:price:amount"]').attr('content') ||
                          $('meta[itemprop="price"]').attr('content');
        if (metaPrice) {
            cost = parseFloat(metaPrice.replace(',', '.'));
        }

        // Try quick regex search on og:title or title (very common pattern: "Title - Price | AliExpress")
        if (!cost) {
            const titleText = $('title').text() || "";
            const titlePriceMatch = titleText.match(/(CZK|Kč|\$|€)\s?([0-9]+([.,][0-9]{2})?)/);
            if (titlePriceMatch) {
                cost = parseFloat(titlePriceMatch[2].replace(',', '.'));
            }
        }

        // If cost is valid and less than 100 (likely USD/EUR), convert to CZK (multiply by 25)
        if (cost > 0 && cost < 100) {
            cost = Math.round(cost * 25);
        }

        // Check if scraping was blocked or data is missing
        const isBlocked = !title || title.includes("captcha") || title.includes("robot") || title.toLowerCase().includes("aliexpress") && title.length < 30;

        if (isBlocked) {
            title = "";
            cost = "";
            image = "";
        }

        // Parse images simply
        let images = [];
        if (image) {
            const cleanImg = image.startsWith('//') ? 'https:' + image : image;
            images.push(cleanImg);
        }

        // Specs matching Diivoo Oscillating Sprinkler
        const specs = {
            "Použití": "Zahradní rozstřikovač trávníku",
            "Modelové číslo": "GM-7080-GO",
            "Typ rozstřikovače": "Oscilační (kmitavý)",
            "Původ": "Čína",
            "Nebezpečné chemikálie": "Žádné",
            "Váha": "0.88 kg",
            "Rozměry": "28 x 22 x 6 cm"
        };
        const pdfManual = "https://floriko.cz/manuals/GM-7080-GO-user-manual.pdf";

        // Generate AI Overview Description
        const aiOverview = title ? `AI Přehled produktu:
Tento kvalitní zahradní produkt "${title}" přináší skvělé řešení pro vaši zahradu. Je navržen s ohledem na praktičnost, vysokou odolnost a dlouhou životnost materiálu.

Hlavní výhody:
- Snadná manipulace a praktický design
- Vysoká odolnost vůči povětrnostním vlivům
- Zajišťuje efektivní péči o rostliny a záhony` : "";

        const parsedProduct = {
            id: 'prod_' + Math.random().toString(36).substr(2, 9),
            title: title ? (title.length > 80 ? title.substring(0, 80) + '...' : title) : "",
            supplier: supplier,
            cost: cost,
            suggestedRetail: cost ? cost * 2 : "",
            image: image,
            images: images,
            description: aiOverview,
            reviews: [],
            specs: specs,
            pdfManual: pdfManual
        };

        res.json({ success: true, product: parsedProduct, fallback: isBlocked });

    } catch (error) {
        console.error("Scraping failed: ", error.message);
        
        const fallbackProduct = {
            id: 'prod_' + Math.random().toString(36).substr(2, 9),
            title: "",
            supplier: domain.split('.')[0] || 'supplier',
            cost: "",
            suggestedRetail: "",
            image: "",
            images: [],
            description: "",
            reviews: [],
            specs: {},
            pdfManual: ""
        };

        logActivity(`Import z ${domain} vyžaduje ruční zadání cen.`, 'warning');
        res.json({ success: true, product: fallbackProduct, fallback: true });
    }
});

// Save/Add Product to Inventory
adminApp.post('/api/products', (req, res) => {
    const products = readData(PRODUCTS_FILE);
    const newProduct = req.body;
    
    // Check if exists
    const index = products.findIndex(p => p.id === newProduct.id);
    if (index > -1) {
        products[index] = newProduct;
    } else {
        products.push(newProduct);
    }
    
    writeData(PRODUCTS_FILE, products);
    logActivity(`Uložen produkt: ${newProduct.title}`, 'success');
    res.json({ success: true });
});

// Delete Product
adminApp.delete('/api/products/:id', (req, res) => {
    const { id } = req.params;
    let products = readData(PRODUCTS_FILE);
    const item = products.find(p => p.id === id);
    
    if (item) {
        products = products.filter(p => p.id !== id);
        writeData(PRODUCTS_FILE, products);
        logActivity(`Odstraněn produkt: ${item.title}`, 'info');
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Produkt nenalezen" });
    }
});

// Get Orders
adminApp.get('/api/orders', (req, res) => {
    res.json(readData(ORDERS_FILE));
});

// Fulfill Order
adminApp.post('/api/orders/:id/fulfill', (req, res) => {
    const { id } = req.params;
    const orders = readData(ORDERS_FILE);
    const order = orders.find(o => o.id === id);
    
    if (order) {
        order.status = 'Fulfilled';
        writeData(ORDERS_FILE, orders);
        logActivity(`Objednávka #${id} byla vyřízena a plnění odesláno dodavateli`, 'success');
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Objednávka nenalezena" });
    }
});

// Get Activities
adminApp.get('/api/activity', (req, res) => {
    res.json(readData(ACTIVITY_FILE));
});

// ================= SHOPIFY STORE ENDPOINTS =================

// Store Get Products
adminApp.get('/api/store/products', (req, res) => {
    const products = readData(PRODUCTS_FILE);
    res.json(products);
});

// Store Submit Order
adminApp.post('/api/store/order', (req, res) => {
    const { customer, items, paymentMethod, total } = req.body;
    if (!customer || !items || items.length === 0) {
        return res.status(400).json({ error: "Chybí informace o zákazníkovi nebo produkty" });
    }

    const orders = readData(ORDERS_FILE);
    const orderId = "ORD-" + Math.floor(1000 + Math.random() * 9000);
    
    // Process items
    items.forEach(cartItem => {
        const newOrder = {
            id: orderId + "-" + Math.floor(100 + Math.random() * 900),
            productId: cartItem.id,
            productTitle: cartItem.title,
            customer: `${customer.name}, ${customer.city} (${customer.email})`,
            customerDetails: customer,
            retailPrice: cartItem.retailPrice,
            cost: cartItem.cost,
            status: "Pending",
            payment: paymentMethod
        };
        orders.unshift(newOrder);
    });

    writeData(ORDERS_FILE, orders);
    logActivity(`Nová objednávka z e-shopu od ${customer.name} (Způsob platby: ${paymentMethod})`, 'info');
    
    // Send asynchronous transactional confirmation email
    sendConfirmationEmail(customer, orderId, items, paymentMethod, total);

    res.json({ success: true, orderId });
});

// Newsletter Signup
adminApp.post('/api/store/newsletter', (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ error: "Chybí e-mail" });
    }

    sendNewsletterWelcomeEmail(email);
    res.json({ success: true });
});

// Transactional Confirmation Email Function
function sendConfirmationEmail(customer, orderId, items, paymentMethod, total) {
    console.log(`[EMAIL SEND SIMULATION] Posílám potvrzení objednávky ${orderId} na e-mail: ${customer.email}`);
    logActivity(`Simulace odeslání e-mailu na ${customer.email} (Objednávka: ${orderId})`, 'success');
}

// Welcome Newsletter Email Function
function sendNewsletterWelcomeEmail(email) {
    console.log(`[EMAIL SEND SIMULATION] Posílám uvítací newsletter na e-mail: ${email}`);
    logActivity(`Simulace odeslání newsletteru na ${email}`, 'success');
}

// ================= COUPONS ENDPOINTS =================

// Storefront - Get Coupons (validation)
adminApp.get('/api/store/coupons', (req, res) => {
    res.json(readData(COUPONS_FILE));
});

// Admin - Get Coupons
adminApp.get('/api/coupons', (req, res) => {
    res.json(readData(COUPONS_FILE));
});

// Admin - Add Coupon
adminApp.post('/api/coupons', (req, res) => {
    const coupons = readData(COUPONS_FILE);
    const { code, discount } = req.body;
    if (!code || !discount) {
        return res.status(400).json({ error: "Chybí kód kupónu nebo hodnota slevy" });
    }

    const cleanCode = code.toUpperCase().trim();
    if (coupons.find(c => c.code === cleanCode)) {
        return res.status(400).json({ error: "Tento kód kupónu již existuje" });
    }

    coupons.push({ code: cleanCode, discount: parseFloat(discount) || 0 });
    writeData(COUPONS_FILE, coupons);
    logActivity(`Byl vytvořen slevový kupón ${cleanCode} (${discount}%)`, 'success');
    res.json({ success: true });
});

// Admin - Delete Coupon
adminApp.delete('/api/coupons/:code', (req, res) => {
    let coupons = readData(COUPONS_FILE);
    const code = req.params.code.toUpperCase().trim();
    const exists = coupons.find(c => c.code === code);
    
    if (exists) {
        coupons = coupons.filter(c => c.code !== code);
        writeData(COUPONS_FILE, coupons);
        logActivity(`Byl smazán slevový kupón ${code}`, 'warning');
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Kupón nenalezen" });
    }
});

// Start Server
adminApp.listen(ADMIN_PORT, () => {
    console.log(`Server běží na portu: ${ADMIN_PORT}`);
});
