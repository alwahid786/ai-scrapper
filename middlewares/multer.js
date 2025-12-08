import multer, { memoryStorage } from 'multer';
const singleUpload = multer({ storage: memoryStorage() }).single('file');
export default singleUpload;
