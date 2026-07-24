const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');


const adminApp = express();
const ADMIN_PORT = process.env.PORT || 3000;

// Database paths
const DB_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DB_DIR, 'products.json');
const ORDERS_FILE = path.join(DB_DIR, 'orders.json');
const ACTIVITY_FILE = path.join(DB_DIR, 'activity.json');
const COUPONS_FILE = path.join(DB_DIR, 'coupons.json');
const GIT_TOKEN = process.env.GITHUB_TOKEN || null;
const STRIPE_PUB_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_51Pdummykey');

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

// GitHub Auto-Sync Helper
const gitSync = async (filePath, repoPath, token) => {
    if (!token) return;
    try {
        const owner = "Florikopodpora";
        const repo = "floriko-autodnsd";
        const url = `https://api.github.com/repos/${owner}/${repo}/contents/${repoPath}`;
        
        let sha = null;
        try {
            const getRes = await axios.get(url, {
                headers: { 
                    'Authorization': `token ${token}`,
                    'User-Agent': 'AutoDS-Admin-Sync'
                }
            });
            sha = getRes.data.sha;
        } catch (e) {
            // File might not exist on repo yet
        }
        
        const content = fs.readFileSync(filePath, 'utf8');
        const contentBase64 = Buffer.from(content).toString('base64');
        
        await axios.put(url, {
            message: `Auto-sync: Aktualizace ${repoPath} [skip ci]`,
            content: contentBase64,
            sha: sha
        }, {
            headers: { 
                'Authorization': `token ${token}`,
                'User-Agent': 'AutoDS-Admin-Sync'
            }
        });
        console.log(`[GIT SYNC] Soubor ${repoPath} úspěšně nahrán na GitHub.`);
    } catch (err) {
        console.error(`[GIT SYNC ERROR] Chyba synchronizace ${repoPath}:`, err.response ? err.response.data : err.message);
    }
};

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

    // Trigger GitHub Auto-Sync if token is present
    if (GIT_TOKEN) {
        gitSync(PRODUCTS_FILE, 'data/products.json', GIT_TOKEN);
    }

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

        // Trigger GitHub Auto-Sync if token is present
        if (GIT_TOKEN) {
            gitSync(PRODUCTS_FILE, 'data/products.json', GIT_TOKEN);
        }

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
        
        // Trigger shipping confirmation email to customer
        if (order.customerDetails && order.customerDetails.email) {
            sendShippingEmail(order.customerDetails.name, order.customerDetails.email, id.split('-')[0]);
        }

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
    const { customer, items, paymentMethod, total, couponUsed } = req.body;
    if (!customer || !items || items.length === 0) {
        return res.status(400).json({ error: "Chybí informace o zákazníkovi nebo produkty" });
    }

    // Process coupon deactivation if used
    if (couponUsed) {
        let coupons = readData(COUPONS_FILE);
        const codeToDelete = couponUsed.toUpperCase().trim();
        const initialLen = coupons.length;
        coupons = coupons.filter(c => c.code !== codeToDelete);
        if (coupons.length < initialLen) {
            writeData(COUPONS_FILE, coupons);
            logActivity(`Slevový kupón ${codeToDelete} byl úspěšně použit a deaktivován.`, 'info');
            
            if (GIT_TOKEN) {
                gitSync(COUPONS_FILE, 'data/coupons.json', GIT_TOKEN);
            }
        }
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

// Store Get Stripe Config (Publishable Key)
adminApp.get('/api/store/stripe-config', (req, res) => {
    res.json({ publishableKey: STRIPE_PUB_KEY });
});

// Store Create Stripe Payment Intent
adminApp.post('/api/store/create-payment-intent', async (req, res) => {
    const { total, email } = req.body;
    if (!total) {
        return res.status(400).json({ error: "Chybí částka k zaplacení" });
    }

    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(parseFloat(total) * 100),
            currency: 'czk',
            receipt_email: email,
            payment_method_types: ['card'],
        });

        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (err) {
        console.error("Chyba při vytváření Stripe Payment Intent:", err.message);
        res.status(500).json({ error: "Nepodařilo se vytvořit platební transakci" });
    }
});

// Newsletter Signup
adminApp.post('/api/store/newsletter', (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ error: "Chybí e-mail" });
    }

    sendWelcomeEmail(email.split('@')[0], email);
    res.json({ success: true });
});

// Welcome Email on Registration
adminApp.post('/api/store/welcome-email', (req, res) => {
    const { name, email } = req.body;
    if (!email) {
        return res.status(400).json({ error: "Chybí e-mail" });
    }

    sendWelcomeEmail(name || email.split('@')[0], email);
    res.json({ success: true });
});

// Nodemailer Transport Configuration
const getTransporter = () => {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        return null;
    }
    const host = process.env.EMAIL_HOST || (process.env.EMAIL_USER.includes('@gmail.com') ? 'smtp.gmail.com' : 'smtp.seznam.cz');
    const port = process.env.EMAIL_PORT ? parseInt(process.env.EMAIL_PORT) : 465;
    return nodemailer.createTransport({
        host: host,
        port: port,
        secure: port === 465,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });
};

// Send HTML Email Wrapper
const sendHtmlEmail = async (to, subject, htmlContent) => {
    const transporter = getTransporter();
    if (!transporter) {
        console.log(`[EMAIL SIMULATION] Na ${to} odesílám: "${subject}"`);
        logActivity(`Simulace odeslání e-mailu na ${to} (${subject})`, 'success');
        return;
    }

    try {
        await transporter.sendMail({
            from: `"Floriko E-shop" <${process.env.EMAIL_USER}>`,
            to: to,
            subject: subject,
            html: htmlContent
        });
        console.log(`[EMAIL SENT] E-mail "${subject}" odeslán na ${to}`);
        logActivity(`E-mail "${subject}" byl odeslán na ${to}`, 'success');
    } catch (err) {
        console.error(`[EMAIL ERROR] Chyba odesílání na ${to}:`, err.message);
        logActivity(`Chyba odeslání e-mailu na ${to}: ${err.message}`, 'warning');
    }
};

// 1. Welcome Account Template
function sendWelcomeEmail(name, email) {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Vítejte ve Floriko</title>
        <style>
            body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f7fafc; color: #2d3748; margin: 0; padding: 20px; }
            .card { max-width: 600px; background: #ffffff; margin: 0 auto; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
            .header { background: #1b4d3e; color: #ffffff; padding: 40px 20px; text-align: center; }
            .header h1 { margin: 0; font-size: 24px; font-weight: 700; }
            .content { padding: 40px 30px; line-height: 1.6; }
            .gift-box { background: #f0fdf4; border: 1px dashed #4ade80; border-radius: 12px; padding: 20px; text-align: center; margin: 25px 0; }
            .coupon { font-size: 22px; font-weight: 800; color: #1b4d3e; letter-spacing: 2px; margin: 10px 0; display: inline-block; padding: 8px 20px; background: #ffffff; border-radius: 30px; border: 1px solid #1b4d3e; }
            .footer { background: #edf2f7; text-align: center; padding: 20px; font-size: 12px; color: #718096; }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="header">
                <h1>Vítejte v zahradě Floriko 🌿</h1>
            </div>
            <div class="content">
                <p>Ahoj ${name},</p>
                <p>děkujeme, že jste se registroval(a) na našem e-shopu <strong>Floriko</strong>. Jsme moc rádi, že sdílíte naši vášeň pro minimalistickou zahradní estetiku.</p>
                
                <p>Jako poděkování a uvítací dárek jsme pro vás připravili <strong>slevu 10%</strong> na váš první nákup!</p>
                
                <div class="gift-box">
                    <p style="margin: 0; font-weight: bold; color: #166534;">Váš slevový kód:</p>
                    <div class="coupon">FLORIKO-VITEJ-10</div>
                    <p style="margin: 5px 0 0 0; font-size: 13px; color: #166534;">(Kód stačí zadat v košíku před placením)</p>
                </div>

                <p>Užijte si nakupování designových květináčů, zavlažování a moderního osvětlení.</p>
                <p style="margin-top: 30px;">Krásný den,<br><strong>Tým Floriko</strong></p>
            </div>
            <div class="footer">
                Tento e-mail byl odeslán na adresu ${email}.<br>
                © 2026 Floriko.cz. Všechna práva vyhrazena.
            </div>
        </div>
    </body>
    </html>
    `;
    sendHtmlEmail(email, "Vítejte ve Floriko 🌿 Slevový kód 10% uvnitř!", html);
}

// 2. Order Confirmation Template
function sendConfirmationEmail(customer, orderId, items, paymentMethod, total) {
    let paymentInstructions = "";
    if (paymentMethod === 'bank') {
        paymentInstructions = `
            <div class="box">
                <h3 style="color: #1b4d3e; margin-top: 0;">Pokyny k platbě převodem:</h3>
                <p>Prosím, převeďte částku <strong>${total} Kč</strong> na náš bankovní účet:</p>
                <p style="line-height: 1.5; font-size: 15px;">
                    <strong>Číslo účtu:</strong> 107-3546090267/0100<br>
                    <strong>Banka:</strong> Komerční banka<br>
                    <strong>Částka:</strong> ${total} Kč<br>
                    <strong>Variabilní symbol:</strong> ${orderId.replace(/[^0-9]/g, '') || '9999'}
                </p>
                <p style="font-size: 13px; color: #718096;">Objednávku odešleme ihned po připsání platby na náš účet.</p>
            </div>
        `;
    } else if (paymentMethod === 'paypal') {
        const paypalUrl = `https://www.paypal.com/cgi-bin/webscr?cmd=_xclick&business=densen123@seznam.cz&currency_code=CZK&amount=${total}&item_name=Objednavka%20${orderId}`;
        paymentInstructions = `
            <div class="box">
                <h3 style="color: #003087; margin-top: 0;">Platba přes PayPal:</h3>
                <p>Klikněte na tlačítko níže a proveďte platbu na účet <strong>densen123@seznam.cz</strong>:</p>
                <p style="text-align: center; margin-top: 20px;">
                    <a href="${paypalUrl}" target="_blank" style="background-color: #ffc439; color: #003087; text-decoration: none; padding: 12px 30px; font-weight: bold; border-radius: 30px; display: inline-block;">Zaplatit přes PayPal</a>
                </p>
            </div>
        `;
    } else {
        paymentInstructions = `
            <div class="box" style="background-color: #f0fdf4; border-color: #bbf7d0;">
                <p style="color: #166534; font-weight: bold; margin: 0;">✓ Platba kartou online proběhla úspěšně.</p>
                <p style="margin: 5px 0 0 0; font-size: 13px; color: #166534;">Vaše objednávka se již začíná připravovat k odeslání.</p>
            </div>
        `;
    }

    const itemsRows = items.map(item => `
        <tr>
            <td style="padding: 12px; border-bottom: 1px solid #edf2f7;">
                <img src="${item.image || ''}" style="width: 50px; height: 50px; object-fit: cover; border-radius: 8px; vertical-align: middle; margin-right: 10px;">
                <span style="font-weight: 600; color: #2d3748;">${item.title}</span>
            </td>
            <td style="padding: 12px; text-align: right; border-bottom: 1px solid #edf2f7; color: #2d3748;">${item.retailPrice} Kč</td>
        </tr>
    `).join('');

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Potvrzení objednávky</title>
        <style>
            body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f7fafc; color: #2d3748; margin: 0; padding: 20px; }
            .card { max-width: 600px; background: #ffffff; margin: 0 auto; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
            .header { background: #1b4d3e; color: #ffffff; padding: 30px 20px; text-align: center; }
            .header h1 { margin: 0; font-size: 22px; font-weight: 700; }
            .content { padding: 35px 25px; line-height: 1.6; }
            .box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 25px 0; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th { text-align: left; padding: 12px; background: #edf2f7; color: #4a5568; font-size: 13px; font-weight: 700; }
            .footer { background: #edf2f7; text-align: center; padding: 20px; font-size: 12px; color: #718096; }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="header">
                <h1>Děkujeme za vaši objednávku! 📦</h1>
                <p style="margin: 5px 0 0 0; opacity: 0.9;">Číslo objednávky: #${orderId}</p>
            </div>
            <div class="content">
                <p>Vážený zákazníku,</p>
                <p>přijali jsme vaši objednávku v e-shopu <strong>Floriko</strong>. Níže naleznete rekapitulaci objednaného zboží a doručovacích údajů.</p>
                
                ${paymentInstructions}

                <h3>Shrnutí objednávky:</h3>
                <table>
                    <thead>
                        <tr>
                            <th>Produkt</th>
                            <th style="text-align: right;">Cena</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${itemsRows}
                        <tr>
                            <td style="padding: 12px; font-weight: bold; border-top: 2px solid #edf2f7;">Celková cena:</td>
                            <td style="padding: 12px; text-align: right; font-weight: bold; border-top: 2px solid #edf2f7; font-size: 18px; color: #1b4d3e;">${total} Kč</td>
                        </tr>
                    </tbody>
                </table>

                <h3 style="margin-top: 30px;">Doručovací adresa:</h3>
                <p style="line-height: 1.4; background: #f8fafc; padding: 15px; border-radius: 8px;">
                    <strong>Jméno:</strong> ${customer.name}<br>
                    <strong>Adresa:</strong> ${customer.street}, ${customer.city}<br>
                    <strong>E-mail:</strong> ${customer.email}
                </p>

                <p style="margin-top: 30px;">Pokud máte jakékoliv dotazy, neváhejte odpovědět na tento e-mail.</p>
                <p>Krásný den,<br><strong>Tým Floriko</strong></p>
            </div>
            <div class="footer">
                © 2026 Floriko.cz. Všechna práva vyhrazena.
            </div>
        </div>
    </body>
    </html>
    `;
    sendHtmlEmail(customer.email, `Potvrzení objednávky #${orderId} - Floriko`, html);
}

// 3. Shipping / Fulfillment Template
function sendShippingEmail(customerName, email, orderId) {
    const mockTracking = "VS-" + Math.floor(100000000 + Math.random() * 900000000) + "-CZ";
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Vaše objednávka byla odeslána</title>
        <style>
            body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f7fafc; color: #2d3748; margin: 0; padding: 20px; }
            .card { max-width: 600px; background: #ffffff; margin: 0 auto; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
            .header { background: #1b4d3e; color: #ffffff; padding: 35px 20px; text-align: center; }
            .header h1 { margin: 0; font-size: 22px; font-weight: 700; }
            .content { padding: 35px 25px; line-height: 1.6; }
            .tracking-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; text-align: center; margin: 25px 0; }
            .tracking-code { font-size: 18px; font-weight: 700; color: #2d3748; margin: 10px 0; }
            .footer { background: #edf2f7; text-align: center; padding: 20px; font-size: 12px; color: #718096; }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="header">
                <h1>Balíček je na cestě! 📦✈️</h1>
                <p style="margin: 5px 0 0 0; opacity: 0.9;">Objednávka #${orderId}</p>
            </div>
            <div class="content">
                <p>Vážený zákazníku,</p>
                <p>máme skvělou zprávu! Vaši objednávku jsme úspěšně zabalili a předali přepravní společnosti. Zboží je již na cestě k vám domů.</p>
                
                <div class="tracking-box">
                    <p style="margin: 0; font-size: 14px; color: #718096;">Sledovací číslo zásilky:</p>
                    <div class="tracking-code">${mockTracking}</div>
                    <p style="margin: 15px 0 0 0;">
                        <a href="https://www.postaonline.cz/trackandtrace" target="_blank" style="background-color: #1b4d3e; color: #ffffff; text-decoration: none; padding: 12px 30px; font-weight: bold; border-radius: 30px; display: inline-block;">Sledovat zásilku online</a>
                    </p>
                </div>

                <p>Děkujeme za nákup a věříme, že vám radost z produktů Floriko udělá den o to hezčí!</p>
                <p style="margin-top: 30px;">Krásný den,<br><strong>Tým Floriko</strong></p>
            </div>
            <div class="footer">
                © 2026 Floriko.cz. Všechna práva vyhrazena.
            </div>
        </div>
    </body>
    </html>
    `;
    sendHtmlEmail(email, `Vaše objednávka #${orderId} byla odeslána! 📦`, html);
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

    if (GIT_TOKEN) {
        gitSync(COUPONS_FILE, 'data/coupons.json', GIT_TOKEN);
    }

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

        if (GIT_TOKEN) {
            gitSync(COUPONS_FILE, 'data/coupons.json', GIT_TOKEN);
        }

        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Kupón nenalezen" });
    }
});

// Start Server
adminApp.listen(ADMIN_PORT, () => {
    console.log(`Server běží na portu: ${ADMIN_PORT}`);
});
