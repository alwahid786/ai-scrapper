import { getEnv } from '../config/config.js';

// const returnMailPage = (link) => {
//   return `<!DOCTYPE html>
// <html lang="en">
//   <head>
//     <meta charset="UTF-8" />
//     <meta name="viewport" content="width=device-width, initial-scale=1.0" />
//     <title>Reset Your Password</title>
//     <style>
//       body {
//         margin: 0;
//         padding: 0;
//         background-color: #f4f4f9;
//         font-family: Arial, sans-serif;
//         height: 100vh;
//         display: flex;
//         justify-content: center;
//         align-items: center;
//       }
//       table {
//         border-collapse: collapse;
//         width: 100%;
//       }
//       .container {
//         width: 100%;
//         max-width: 600px;
//         margin: 0 auto;
//         background-color: #ffffff;
//         border-radius: 8px;
//         box-shadow: 0 4px 10px rgba(0, 0, 0, 0.1);
//         overflow: hidden;
//       }
//       .header {
//         background-color: #6c63ff;
//         color: #ffffff;
//         text-align: center;
//         padding: 20px;
//       }
//       .header h1 {
//         margin: 0;
//         font-size: 24px;
//       }
//       .content {
//         padding: 20px;
//         text-align: center;
//       }
//       .content p {
//         font-size: 16px;
//         color: #333333;
//         line-height: 1.6;
//       }
//       .button {
//         display: inline-block;
//         margin: 20px 0;
//         padding: 12px 25px;
//         font-size: 16px;
//         background-color: #6c63ff;
//         color: #ffffff ! important;
//         text-decoration: none;
//         border-radius: 5px;
//         cursor: pointer;
//       }
//       .button:hover {
//         background-color: #5548c8;
//       }
//       .footer {
//         background-color: #f4f4f9;
//         text-align: center;
//         padding: 15px;
//         font-size: 12px;
//         color: #777777;
//       }
//       @media screen and (max-width: 600px) {
//         .container {
//           width: 90%;
//           margin: 10px auto;
//         }
//         .content p {
//           font-size: 14px;
//         }
//         .button {
//           font-size: 14px;
//           padding: 10px 20px;
//         }
//         .header h1 {
//           font-size: 20px;
//         }
//       }
//     </style>
//   </head>
//   <body>
//     <table role="presentation" class="container">
//       <tr>
//         <td class="header">
//           <h1>Reset Your Password</h1>
//         </td>
//       </tr>
//       <tr>
//         <td class="content">
//           <p>Click the button below to reset your password.</p>
//           <a href="${link}" class="button">Reset Password</a>
//         </td>
//       </tr>
//       <tr>
//         <td class="footer">
//           <p>If you did not request a password reset, please ignore this email.</p>
//         </td>
//       </tr>
//     </table>
//   </body>
// </html>
// `;
// };

const returnMailPage = (name, setupPasswordUrl) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Set Your Password</title>
  <style>
    body { font-family: Arial, sans-serif; background-color: #f4f4f7; margin:0; padding:0; }
    .container { max-width:600px; margin:30px auto; background:#fff; border-radius:8px; padding:30px; box-shadow:0 2px 8px rgba(0,0,0,0.1);}
    h2 { color: #333; }
    p { color:#555; line-height:1.5; }
    .btn { display:inline-block; padding:12px 25px; margin-top:20px; background-color:#4CAF50; color:white; text-decoration:none; border-radius:5px; font-weight:bold; }
    .footer { margin-top:30px; font-size:12px; color:#888; text-align:center;}
  </style>
</head>
<body>
  <div class="container">
    <h2>Hello ${name},</h2>
    <p>We received a request to reset your password. Click the button below to continue:</p>
    <a href="${setupPasswordUrl}" class="btn" target="_blank">Set Password</a>
    <p>If you did not expect this email, you can ignore it.</p>
    <div class="footer">&copy; ${new Date().getFullYear()} Your Company. All rights reserved.</div>
  </div>
</body>
</html>
`;

export { returnMailPage };
