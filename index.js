import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import cors from "cors";
import "dotenv/config";

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// The project's .env file defines MONGODB_URL. Keep this name in sync with it.
const mongoUrl = process.env.MONGODB_URL;
if (!mongoUrl) {
  throw new Error(
    "Missing MONGODB_URL. Add MONGODB_URL=<your MongoDB connection string> to the .env file.",
  );
}

const client = new MongoClient(mongoUrl);
export async function connectToMongoDB() {
  await client.connect();
  console.log("You successfully connected to MongoDB!");
  return client;
}

const mongoClient = await connectToMongoDB();
const db = mongoClient.db("booknook");
const booksCollection = db.collection("books");
const borrowsCollection = db.collection("borrows");

app.get("/", (req, res) => {
  res.send("Hello World!");
});
//localhost:3000/

app.post("/add-book", async (req, res) => {
  const data = req.body;
  // console.log(data);
  const bookData = {
    ...data,
    addedDate: new Date(),
  };
  const result = await booksCollection.insertOne(bookData);
  console.log(result);
  res.send(result);
});
// http://localhost:5000/add-book

app.get("/books", async (req, res) => {
  const result = await booksCollection.find().sort({ addedDate: -1 }).toArray();
  res.send(result);
});
//.sort({ addedDate: -1 })
// http://localhost:5000/books

app.get("/books/:id", async (req, res) => {
  const { id } = req.params;
  // console.log(id);
  const result = await booksCollection.findOne({
    _id: new ObjectId(id),
  });
  res.send(result);
});
// http://localhost:5000/books/id

app.listen(port, () => {
  console.log(`Example app listening on port http://localhost:${port}`);
});

export default app;
