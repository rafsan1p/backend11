const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const port = process.env.PORT || 5000;
const stripe = require('stripe')(process.env.STRIPE_SECRATE);

const app = express();
app.use(cors());
app.use(express.json());

const admin = require("firebase-admin");
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: 'unauthorize access' })
  }
  try {
    const idToken = token.split(' ')[1]
    const decoded = await admin.auth().verifyIdToken(idToken)
    req.decoded_email = decoded.email;
    next();
  }
  catch (error) {
    return res.status(401).send({ message: 'unauthorize access' })
  }
}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.bq2avso.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    await client.connect();

    const database = client.db('missionscic11DB');
    const userCollections = database.collection('user');
    const requestsCollections = database.collection('request')
    const paymentsCollection = database.collection('payments')


    // ==================== USER ROUTES ====================

    // Create new user
    app.post('/users', async (req, res) => {
      const userInfo = req.body;

      // Check if user already exists
      const existingUser = await userCollections.findOne({ email: userInfo.email });
      if (existingUser) {
        return res.status(400).send({ message: 'User already exists' });
      }

      userInfo.createdAt = new Date();
      userInfo.role = userInfo?.role || 'donor'
      userInfo.status = 'active'

      const result = await userCollections.insertOne(userInfo);
      res.send(result);
    });

    // Get all users (Admin only)
    app.get('/users', verifyFBToken, async (req, res) => {
      const result = await userCollections.find().toArray();
      res.status(200).send(result)
    })

    // Get user role by email
    app.get('/users/role/:email', async (req, res) => {
      const { email } = req.params;
      const query = { email: email };
      const result = await userCollections.findOne(query);
      res.send(result);
    });

    // Update user status (block/unblock)
    app.patch('/update/user/status', verifyFBToken, async (req, res) => {
      const { email, status } = req.query;
      const query = { email: email };
      const updateStatus = {
        $set: {
          status: status
        }
      }
      const result = await userCollections.updateOne(query, updateStatus)
      res.send(result)
    })

    // Update user role (make admin/volunteer)
    app.patch('/update/user/role', verifyFBToken, async (req, res) => {
      const { email, role } = req.body;
      const query = { email: email };
      const updateRole = {
        $set: {
          role: role
        }
      }
      const result = await userCollections.updateOne(query, updateRole)
      res.send(result)
    })

    // Update user profile
    app.patch('/users/:email', verifyFBToken, async (req, res) => {
      const email = req.params.email;
      const updateData = req.body;

      // Remove email from update data (email should not be editable)
      delete updateData.email;

      const query = { email: email };
      const update = {
        $set: updateData
      }
      const result = await userCollections.updateOne(query, update)
      res.send(result)
    })

    // Search donors - FIXED VERSION
app.get('/search-donors', async (req, res) => {
  try {
    let { bloodGroup, district, upazila } = req.query;
    
    console.log('📥 Raw params:', req.query);
    
    // Decode URL encoded characters
    if(bloodGroup) {
      bloodGroup = decodeURIComponent(bloodGroup);
    }
    
    const query = { status: 'active' };

    if (bloodGroup && bloodGroup.trim() !== '') {
      query.blood = bloodGroup.trim();
    }
    if (district && district.trim() !== '') {
      query.district = district.trim();
    }
    if (upazila && upazila.trim() !== '') {
      query.upazila = upazila.trim();
    }

    console.log('🔍 Search Query:', query);
    const result = await userCollections.find(query).toArray();
    console.log('✅ Found donors:', result.length);
    
    res.send(result);
  } catch (err) {
    console.error('❌ Search error:', err);
    res.status(500).send({ error: 'Search failed', details: err.message });
  }
})
    
    // ==================== DONATION REQUEST ROUTES ====================

    // Create donation request
    app.post('/requests', verifyFBToken, async (req, res) => {
      const data = req.body;

      // Check if user is blocked
      const user = await userCollections.findOne({ email: data.requester_email });
      if (user?.status === 'blocked') {
        return res.status(403).send({ message: 'Blocked users cannot create donation requests' });
      }

      data.createdAt = new Date();
      data.donation_status = 'pending';

      const result = await requestsCollections.insertOne(data);
      res.send(result);
    })

    // Get my donation requests (with pagination & filter)
    app.get('/my-request', verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      const size = Number(req.query.size) || 10;
      const page = Number(req.query.page) || 0;
      const status = req.query.status; // Filter by status

      const query = { requester_email: email };

      if (status && status !== 'all') {
        query.donation_status = status;
      }

      const result = await requestsCollections
        .find(query)
        .sort({ createdAt: -1 })
        .limit(size)
        .skip(size * page)
        .toArray();

      const totalRequest = await requestsCollections.countDocuments(query)
      res.send({ request: result, totalRequest })
    })

    // Get all donation requests (Admin/Volunteer)
    app.get('/all-requests', verifyFBToken, async (req, res) => {
      const size = Number(req.query.size) || 10;
      const page = Number(req.query.page) || 0;
      const status = req.query.status;

      const query = {};

      if (status && status !== 'all') {
        query.donation_status = status;
      }

      const result = await requestsCollections
        .find(query)
        .sort({ createdAt: -1 })
        .limit(size)
        .skip(size * page)
        .toArray();

      const totalRequest = await requestsCollections.countDocuments(query)
      res.send({ requests: result, totalRequest })
    })

    // Get pending requests (Public - for donation requests page)
    app.get('/pending-requests', async (req, res) => {
      const query = { donation_status: 'pending' };
      const result = await requestsCollections
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    })

    // Get single request by ID
    app.get('/requests/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await requestsCollections.findOne(query);
      res.send(result);
    })

    // Get recent 3 requests for dashboard
    app.get('/recent-requests/:email', verifyFBToken, async (req, res) => {
      const email = req.params.email;
      const query = { requester_email: email };
      const result = await requestsCollections
        .find(query)
        .sort({ createdAt: -1 })
        .limit(3)
        .toArray();
      res.send(result);
    })

    // Update donation request
    app.patch('/requests/:id', verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const updateData = req.body;
      const query = { _id: new ObjectId(id) };

      const update = {
        $set: updateData
      }
      const result = await requestsCollections.updateOne(query, update);
      res.send(result);
    })

    // Update donation status
    app.patch('/requests/:id/status', verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;
      const query = { _id: new ObjectId(id) };

      const update = {
        $set: {
          donation_status: status
        }
      }
      const result = await requestsCollections.updateOne(query, update);
      res.send(result);
    })

    // Assign donor to request (when donor clicks donate)
    app.patch('/requests/:id/assign-donor', verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const { donorName, donorEmail } = req.body;
      const query = { _id: new ObjectId(id) };

      const update = {
        $set: {
          donation_status: 'inprogress',
          donor_info: {
            name: donorName,
            email: donorEmail
          }
        }
      }
      const result = await requestsCollections.updateOne(query, update);
      res.send(result);
    })

    // Delete donation request
    app.delete('/requests/:id', verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await requestsCollections.deleteOne(query);
      res.send(result);
    })

    // Search donation requests (for public page)
    app.get('/search-requests', async (req, res) => {
      const { bloodGroup, district, upazila } = req.query;

      const query = {};

      if (bloodGroup) {
        query.blood_group = bloodGroup;
      }
      if (district) {
        query.recipient_district = district;
      }
      if (upazila) {
        query.recipient_upazila = upazila;
      }

      const result = await requestsCollections.find(query).toArray();
      res.send(result);
    })

    // ==================== DASHBOARD STATS ====================

    // Admin stats
    app.get('/stats/admin', verifyFBToken, async (req, res) => {
      const totalUsers = await userCollections.countDocuments({ role: 'donor' });
      const totalRequests = await requestsCollections.countDocuments();

      // Calculate total funding
      const payments = await paymentsCollection.find().toArray();
      const totalFunding = payments.reduce((sum, payment) => sum + payment.amount, 0);

      res.send({
        totalUsers,
        totalRequests,
        totalFunding
      });
    })

    // ==================== PAYMENT ROUTES ====================

    // Create payment checkout
    app.post('/create-payment-checkout', async (req, res) => {
      const information = req.body;
      const amount = parseInt(information.donateAmount) * 100;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'usd',
              unit_amount: amount,
              product_data: {
                name: 'Blood Donation Fund'
              }
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        metadata: {
          donorName: information?.donorName,
          donorEmail: information?.donorEmail
        },
        customer_email: information.donorEmail,
        success_url: `${process.env.SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/payment-cancelled`,
      });

      res.send({ url: session.url })
    })

    // Success payment
    app.post('/success-payment', async (req, res) => {
      const { session_id } = req.query;
      const session = await stripe.checkout.sessions.retrieve(session_id);

      const transactionId = session.payment_intent;

      const isPaymentExist = await paymentsCollection.findOne({ transactionId })

      if (isPaymentExist) {
        return res.send({ success: true, message: 'Payment already recorded' })
      }

      if (session.payment_status == 'paid') {
        const paymentInfo = {
          amount: session.amount_total / 100,
          currency: session.currency,
          donorEmail: session.customer_email,
          donorName: session.metadata.donorName,
          transactionId,
          payment_status: session.payment_status,
          paidAt: new Date()
        }
        const result = await paymentsCollection.insertOne(paymentInfo)
        return res.send(result)
      }
    })

    // Get all payments (for funding page)
    app.get('/payments', verifyFBToken, async (req, res) => {
      const result = await paymentsCollection
        .find()
        .sort({ paidAt: -1 })
        .toArray();
      res.send(result);
    })

    // Get total funding amount
    app.get('/payments/total', async (req, res) => {
      const payments = await paymentsCollection.find().toArray();
      const total = payments.reduce((sum, payment) => sum + payment.amount, 0);
      res.send({ total });
    })


    await client.db("admin").command({ ping: 1 });
    console.log("✅ Connected to MongoDB!");
  } catch (error) {
    console.error("❌ MongoDB Error:", error);
  }
}
run().catch(console.dir);


app.get('/', (req, res) => {
  res.send('🩸 Blood Donation Server is running');
});

app.listen(port, () => {
  console.log(`🚀 Server running on port: ${port}`);
});