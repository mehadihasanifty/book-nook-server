import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import cors from "cors";
import { createHmac, timingSafeEqual } from "node:crypto";
import "dotenv/config";

const app = express();
const port = Number(process.env.PORT) || 5000;
const mongoUrl = process.env.MONGODB_URL;
const jwtSecret = process.env.API_JWT_SECRET;

if (!mongoUrl) throw new Error("Missing MONGODB_URL in the server .env file.");
if (!jwtSecret) throw new Error("Missing API_JWT_SECRET in the server .env file.");

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:3000" }));
app.use(express.json({ limit: "1mb" }));

const client = new MongoClient(mongoUrl);
await client.connect();
console.log("Connected to MongoDB");

const db = client.db(process.env.MONGODB_DB || "book-nook");
const books = db.collection("books");
const borrows = db.collection("borrows");
await borrows.createIndex(
  { bookId: 1, userEmail: 1 },
  { unique: true, partialFilterExpression: { returnedAt: null } },
);

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const signature = (value) =>
  createHmac("sha256", jwtSecret).update(value).digest("base64url");

function requireAuth(req, res, next) {
  const token = req.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return res.status(401).json({ message: "Sign in to continue." });

  try {
    const [header, payload, suppliedSignature] = token.split(".");
    if (!header || !payload || !suppliedSignature) throw new Error("Invalid token");
    const expected = Buffer.from(signature(`${header}.${payload}`));
    const actual = Buffer.from(suppliedSignature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error("Invalid token signature");
    }
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!claims.email || !claims.exp || claims.exp <= Math.floor(Date.now() / 1000)) {
      throw new Error("Expired token");
    }
    req.user = { email: String(claims.email).toLowerCase(), name: claims.name || "" };
    next();
  } catch {
    return res.status(401).json({ message: "Your session expired. Please sign in again." });
  }
}

function validId(id) {
  return ObjectId.isValid(id) && String(new ObjectId(id)) === id;
}

function handleError(res, error) {
  console.error(error);
  return res.status(500).json({ message: "Something went wrong. Please try again." });
}



// GET /books — public shelf
app.get("/books", async (_req, res) => {
  try {
    const result = await books.find().sort({ addedDate: -1 }).toArray();
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

// GET /books/:id — book details require a signed-in reader
app.get("/books/:id", requireAuth, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ message: "Invalid book ID." });
  try {
    const book = await books.findOne({ _id: new ObjectId(req.params.id) });
    if (!book) return res.status(404).json({ message: "Book not found." });
    res.json(book);
  } catch (error) {
    handleError(res, error);
  }
});




// POST /books — add a book for the authenticated reader
app.post("/books", requireAuth, async (req, res) => {
  const { title, author, category, image, description, totalCopies } = req.body ?? {};
  const copies = Number(totalCopies);
  if (!title?.trim() || !author?.trim() || !category || !image || !description?.trim() ||
      !Number.isInteger(copies) || copies < 1) {
    return res.status(400).json({ message: "Fill in all book fields and enter at least one copy." });
  }
  try {
    const book = {
      title: title.trim(), author: author.trim(), category, image,
      description: description.trim(), totalCopies: copies,
      userName: req.user.name, userEmail: req.user.email, addedDate: new Date(),
    };
    const result = await books.insertOne(book);
    res.status(201).json({ ...book, _id: result.insertedId });
  } catch (error) {
    handleError(res, error);
  }
});




// PATCH /books/:id — only the book's owner can edit it
app.patch("/books/:id", requireAuth, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ message: "Invalid book ID." });
  const allowed = ["title", "author", "category", "image", "description", "totalCopies"];
  const update = Object.fromEntries(allowed.filter((key) => key in (req.body ?? {})).map((key) => [key, req.body[key]]));
  if (!Object.keys(update).length) return res.status(400).json({ message: "No book changes were provided." });
  if ("totalCopies" in update) {
    update.totalCopies = Number(update.totalCopies);
    if (!Number.isInteger(update.totalCopies) || update.totalCopies < 0) {
      return res.status(400).json({ message: "Total copies must be zero or more." });
    }
  }
  for (const key of ["title", "author", "description"]) {
    if (key in update) update[key] = String(update[key]).trim();
  }
  try {
    const result = await books.updateOne(
      { _id: new ObjectId(req.params.id), userEmail: req.user.email },
      { $set: update },
    );
    if (!result.matchedCount) return res.status(404).json({ message: "Book not found or you do not own it." });
    res.json({ message: "Book updated successfully." });
  } catch (error) {
    handleError(res, error);
  }
});



// DELETE /books/:id — owner only; books with active loans must be returned first
app.delete("/books/:id", requireAuth, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ message: "Invalid book ID." });
  try {
    const id = new ObjectId(req.params.id);
    const book = await books.findOne({ _id: id, userEmail: req.user.email });
    if (!book) return res.status(404).json({ message: "Book not found or you do not own it." });
    if (await borrows.findOne({ bookId: id.toString(), returnedAt: null })) {
      return res.status(409).json({ message: "This book has active borrows. Wait until it is returned before deleting it." });
    }
    await books.deleteOne({ _id: id, userEmail: req.user.email });
    res.json({ message: "Book deleted successfully." });
  } catch (error) {
    handleError(res, error);
  }
});




// POST /borrows — atomic stock decrement plus one active borrow per reader/book
app.post("/borrows", requireAuth, async (req, res) => {
  const { bookId } = req.body ?? {};
  if (!validId(bookId)) return res.status(400).json({ message: "Invalid book ID." });
  const id = new ObjectId(bookId);
  try {
    const book = await books.findOne({ _id: id });
    if (!book) return res.status(404).json({ message: "Book not found." });
    if (await borrows.findOne({ bookId: id.toString(), userEmail: req.user.email, returnedAt: null })) {
      return res.status(409).json({ message: "You already have an active borrow for this book." });
    }
    const stock = await books.updateOne({ _id: id, totalCopies: { $gt: 0 } }, { $inc: { totalCopies: -1 } });
    if (!stock.modifiedCount) return res.status(409).json({ message: "No copies are available right now." });
    const borrowDate = new Date();
    const returnDate = new Date(borrowDate);
    returnDate.setDate(returnDate.getDate() + 14);
    const borrow = {
      bookId: id.toString(), bookTitle: book.title, bookImage: book.image,
      userName: req.user.name, userEmail: req.user.email,
      borrowDate, returnDate, returnedAt: null,
    };
    try {
      const result = await borrows.insertOne(borrow);
      return res.status(201).json({ ...borrow, _id: result.insertedId });
    } catch (error) {
      await books.updateOne({ _id: id }, { $inc: { totalCopies: 1 } });
      if (error?.code === 11000) return res.status(409).json({ message: "You already have an active borrow for this book." });
      throw error;
    }
  } catch (error) {
    handleError(res, error);
  }
});

// GET /borrows — only the authenticated reader's loans
app.get("/borrows", requireAuth, async (req, res) => {
  try {
    res.json(await borrows.find({ userEmail: req.user.email, returnedAt: null }).sort({ borrowDate: -1 }).toArray());
  } catch (error) {
    handleError(res, error);
  }
});



// DELETE /borrows/:id — return only the reader's own loan and restore one copy
app.delete("/borrows/:id", requireAuth, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ message: "Invalid borrow ID." });
  try {
    const borrow = await borrows.findOneAndUpdate(
      { _id: new ObjectId(req.params.id), userEmail: req.user.email, returnedAt: null },
      { $set: { returnedAt: new Date() } },
      { returnDocument: "before" },
    );
    if (!borrow) return res.status(404).json({ message: "Active borrow not found." });
    if (validId(borrow.bookId)) await books.updateOne({ _id: new ObjectId(borrow.bookId) }, { $inc: { totalCopies: 1 } });
    res.json({ message: "Book returned successfully." });
  } catch (error) {
    handleError(res, error);
  }
});

app.listen(port, () => console.log(`Server is running:${port}`));

export default app;
