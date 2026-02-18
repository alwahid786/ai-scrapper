import multer, { memoryStorage } from 'multer';

const singleUpload = multer({ storage: memoryStorage() }).single('file');

/** Up to 60 images for subject property upload. Accepts field name "images" or "images[]". */
const propertyImagesUpload = multer({
  storage: memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
}).fields([
  { name: 'images', maxCount: 60 },
  { name: 'images[]', maxCount: 60 },
]);

export default singleUpload;
export { propertyImagesUpload };