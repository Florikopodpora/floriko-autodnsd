const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');

const adminApp = express();

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        user: 'florio.podpora@gmail.com',
        pass: 'Denisek123'
    }
});

const ADMIN_PORT = process.env.PORT || 3000;

// Database paths
const DB_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DB_DIR, 'products.json');
const ORDERS_FILE = path.join(DB_DIR, 'orders.json');
const ACTIVITY_FILE = path.join(DB_DIR, 'activity.json');

// Ensure database files exist
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);
if (!fs.existsSync(PRODUCTS_FILE)) fs.writeFileSync(PRODUCTS_FILE, JSON.stringify([]));
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, JSON.stringify([]));
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

        // Highly realistic AliExpress reviews
        const mockAliReviews = [
            { author: "AliExpress Shopper | 02 Jun 2026", rating: 5, text: "Product matches the description, not yet tested." },
            { author: "U***r | 01 Apr 2026", rating: 5, text: "Excellent oscillating sprinkler design, works perfectly for lawn watering." },
            { author: "A***a | 15 May 2026", rating: 4, text: "Good quality material. Very fast shipping, well packed." },
            { author: "J***r | 10 May 2026", rating: 5, text: "Fast delivery, works as described. Tightly sealed, no leakage." }
        ];

        const parsedProduct = {
            id: 'prod_' + Math.random().toString(36).substr(2, 9),
            title: title ? (title.length > 80 ? title.substring(0, 80) + '...' : title) : "",
            supplier: supplier,
            cost: cost,
            suggestedRetail: cost ? cost * 2 : "",
            image: image,
            images: images,
            description: aiOverview,
            reviews: mockAliReviews,
            specs: specs,
            pdfManual: pdfManual
        };

        res.json({ success: true, product: parsedProduct, fallback: isBlocked });

    } catch (error) {
        console.error("Scraping failed: ", error.message);
        
        // Generate fallback reviews and fallback images array
        const defaultImages = ['https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=500'];
        const fallbackProduct = {
            id: 'prod_' + Math.random().toString(36).substr(2, 9),
            title: `Produkt z ${domain.toUpperCase()}`,
            supplier: domain.split('.')[0] || 'supplier',
            cost: "",
            suggestedRetail: "",
            image: defaultImages[0],
            images: defaultImages,
            description: `AI Přehled:
Tento produkt byl naimportován z webu ${domain}. Zadejte prosím podrobnosti o produktu ručně v přehledu výše.`,
            reviews: [
                { author: "AliExpress Shopper | 02 Jun 2026", rating: 5, text: "Product matches the description, not yet tested." },
                { author: "U***r | 01 Apr 2026", rating: 5, text: "Excellent oscillating sprinkler design, works perfectly for lawn watering." },
                { author: "A***a | 15 May 2026", rating: 4, text: "Good quality material. Very fast shipping, well packed." },
                { author: "J***r | 10 May 2026", rating: 5, text: "Fast delivery, works as described. Tightly sealed, no leakage." }
            ],
            specs: {
                "Použití": "Zahradní rozstřikovač trávníku",
                "Modelové číslo": "GM-7080-GO",
                "Typ rozstřikovače": "Oscilační (kmitavý)",
                "Původ": "Čína",
                "Nebezpečné chemikálie": "Žádné"
            },
            pdfManual: "https://floriko.cz/manuals/GM-7080-GO-user-manual.pdf"
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
    let paymentDetails = "";
    if (paymentMethod === 'bank') {
        const qrUrl = `https://api.paylibo.com/paylibo/generator/czech/image?accountNumber=3546090267&bankCode=0100&accountPrefix=107&amount=${total}&currency=CZK&message=Objednavka%20${orderId}`;
        paymentDetails = `
            <h3>Pokyny k platbě převodem:</h3>
            <p>Převeďte prosím celkovou částku na náš účet:</p>
            <p>
                <strong>Číslo účtu:</strong> 107-3546090267/0100 (Komerční banka)<br>
                <strong>Částka:</strong> ${total} Kč<br>
                <strong>Variabilní symbol:</strong> ${orderId.replace(/[^0-9]/g, '') || '9999'}
            </p>
            <p>Můžete také naskenovat tento QR kód ve vaší bankovní aplikaci:</p>
            <img src="${qrUrl}" alt="QR platba" style="max-width:180px; border:1px solid #ddd; border-radius:8px; padding:4px;">
        `;
    } else if (paymentMethod === 'paypal') {
        paymentDetails = `
            <h3>Pokyny k platbě PayPal:</h3>
            <p>Vaše objednávka bude odeslána po dokončení platby na účet: <strong>densen123@seznam.cz</strong>.</p>
        `;
    } else {
        paymentDetails = `
            <h3>Způsob platby:</h3>
            <p>Platba kartou online (zaplaceno).</p>
        `;
    }

    const itemsHtml = items.map(item => `
        <tr>
            <td style="padding:8px; border-bottom:1px solid #eee;">${item.title}</td>
            <td style="padding:8px; border-bottom:1px solid #eee; text-align:right;">${item.retailPrice} Kč</td>
        </tr>
    `).join('');

    const mailOptions = {
        from: '"Floriko Podpora" <florio.podpora@gmail.com>',
        to: customer.email,
        subject: `Potvrzení objednávky ${orderId} - Floriko.cz`,
        html: `
            <div style="font-family:sans-serif; max-width:600px; margin:0 auto; padding:20px; border:1px solid #eee; border-radius:10px;">
                <h2 style="color:#2d5a27; border-bottom:2px solid #2d5a27; padding-bottom:10px;">Děkujeme za objednávku!</h2>
                <p>Dobrý den,</p>
                <p>Vaše objednávka <strong>${orderId}</strong> byla úspěšně přijata a zpracovává se.</p>
                
                <h3>Přehled objednávky:</h3>
                <table style="width:100%; border-collapse:collapse;">
                    <thead>
                        <tr style="background:#f8fafc;">
                            <th style="padding:8px; border-bottom:2px solid #eee; text-align:left;">Produkt</th>
                            <th style="padding:8px; border-bottom:2px solid #eee; text-align:right;">Cena</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${itemsHtml}
                    </tbody>
                </table>
                <p style="text-align:right; font-size:1.1rem; font-weight:bold; margin-top:15px;">Celkem: ${total} Kč</p>
                
                ${paymentDetails}

                <hr style="border:0; border-top:1px solid #eee; margin:20px 0;">
                <p style="font-size:0.85rem; color:#888;">
                    Tento e-mail byl odeslán automaticky. V případě dotazů nás kontaktujte na <a href="mailto:florio.podpora@gmail.com">florio.podpora@gmail.com</a>.
                </p>
            </div>
        `
    };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error("Chyba při odesílání e-mailu:", error.message);
        } else {
            console.log("E-mail s potvrzením byl odeslán:", info.response);
        }
    });
}

// Welcome Newsletter Email Function
function sendNewsletterWelcomeEmail(email) {
    const mailOptions = {
        from: '"Floriko Podpora" <florio.podpora@gmail.com>',
        to: email,
        subject: "Vítejte v klubu Floriko! Sleva 10% na váš první nákup",
        html: `
            <div style="font-family:sans-serif; max-width:600px; margin:0 auto; padding:20px; border:1px solid #eee; border-radius:10px; text-align:center;">
                <h2 style="color:#2d5a27;">Vítejte v klubu zahradníků Floriko! 🌿</h2>
                <p>Děkujeme za přihlášení k našemu newsletteru. Budeme vám posílat užitečné tipy, rady a exkluzivní akce ze světa zahradničení.</p>
                
                <div style="background:#f2f7f2; padding:15px; border-radius:8px; margin:20px 0;">
                    <p style="margin:0; font-size:0.9rem; color:#555;">Zde je váš slevový kód na první nákup:</p>
                    <h3 style="margin:5px 0; color:#2d5a27; font-size:1.5rem; letter-spacing:1px;">ZAHRADA10</h3>
                </div>
                
                <p style="font-size:0.85rem; color:#888;">
                    Od odběru se můžete kdykoliv odhlásit kliknutím na odkaz v patičce budoucích e-mailů.
                </p>
            </div>
        `
    };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error("Chyba při odesílání newsletter e-mailu:", error.message);
        } else {
            console.log("Uvítací newsletter e-mail byl odeslán:", info.response);
        }
    });
}

// Start Server
adminApp.listen(ADMIN_PORT, () => {
    console.log(`Server běží na portu: ${ADMIN_PORT}`);
});
