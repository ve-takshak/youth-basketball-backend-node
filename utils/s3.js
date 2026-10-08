const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');


const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});


let upload_files = async (folder, files) => {

    let imagePath = '';

    if (files) {

        let image = files;
        let dateTime = Date.now();
        let imageName = dateTime + "_" + image.name.replace(/\s+/g, "_");

        // Read content from the file
        const fileContent = Buffer.from(image.data, 'binary');

        // Setting up S3 upload parameters
        const params = {
            Bucket: process.env.S3_BUCKET,
            Key: folder + '/' + imageName, // File name you want to save as in S3
            Body: fileContent,
            ContentType: image.mimetype,
        };

        // Uploading files to the bucket
        try {

            await s3.send(new PutObjectCommand(params));

            imagePath = `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${params.Key}`;

        } catch (e) {
            console.log("Error uploading data: ", e);
            return '';
        }

    }

    return imagePath;
}


const deleteFiles = async (folder, fileName) => {

    const params = {
        Bucket: process.env.S3_BUCKET,
        Key: folder + "/" + fileName
    };

    try {

        await s3.send(new DeleteObjectCommand(params));

        return 1

    } catch (e) {
        return e;
    }

}


module.exports = { upload_files, deleteFiles }